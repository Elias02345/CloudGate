/**
 * Wraps a single cloudflared child process.
 *
 * Responsibilities:
 *  - spawn / kill the daemon
 *  - capture stdout/stderr → ring buffer + pino log file
 *  - SIGHUP reload after config changes
 *  - health-poll the metrics endpoint
 *  - exponential backoff on crash + auto-restart
 *
 * One instance per managed tunnel. tunnel-manager.ts owns the lifecycle.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { childLogger } from '../logger.js';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_RESET_AFTER_MS = 60_000;
const LOG_BUFFER_LINES = 1000;

type Status = 'starting' | 'running' | 'stopped' | 'error';

interface ProcessOpts {
	tunnelId: string;
	configPath: string;
	metricsAddr?: string; // e.g. '127.0.0.1:36500'
	binPath?: string;
	onStatusChange?: (status: Status, err?: string) => void;
	onLog?: (line: string) => void;
}

export class CloudflaredProcess {
	readonly tunnelId: string;
	private opts: ProcessOpts;
	private child: ChildProcess | null = null;
	private status: Status = 'stopped';
	private intentionallyStopped = false;
	private healthTimer: NodeJS.Timeout | null = null;
	private backoffMs = 1000;
	private lastStartMs = 0;
	private logBuffer: string[] = [];
	private logger = childLogger('cloudflared-process');
	private metricsAddr: string;
	private binPath: string;

	constructor(opts: ProcessOpts) {
		this.opts = opts;
		this.tunnelId = opts.tunnelId;
		this.metricsAddr = opts.metricsAddr ?? '127.0.0.1:36500';
		this.binPath = opts.binPath ?? 'cloudflared';
	}

	get currentStatus(): Status {
		return this.status;
	}

	getLogs(maxLines = 200): string[] {
		return this.logBuffer.slice(-maxLines);
	}

	start(): void {
		if (this.child) return;
		this.intentionallyStopped = false;
		this.spawnOnce();
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			this.intentionallyStopped = true;
			this.stopHealthTimer();
			if (!this.child) {
				this.setStatus('stopped');
				resolve();
				return;
			}
			const child = this.child;
			child.once('exit', () => {
				this.setStatus('stopped');
				resolve();
			});
			child.kill('SIGTERM');
			setTimeout(() => {
				if (this.child === child) child.kill('SIGKILL');
			}, 5000).unref();
		});
	}

	/**
	 * Reload via SIGHUP. Cloudflared re-reads its config without dropping
	 * established tunnel connections. If validation fails first, throw — caller
	 * is responsible for not breaking the running daemon.
	 */
	reload(): void {
		if (!this.child || this.status !== 'running') {
			this.logger.warn({ tunnelId: this.tunnelId }, 'reload requested but daemon not running');
			return;
		}
		try {
			this.child.kill('SIGHUP');
			this.logger.info({ tunnelId: this.tunnelId }, 'Sent SIGHUP for config reload');
		} catch (err) {
			this.logger.warn({ err: (err as Error).message }, 'SIGHUP failed');
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private spawnOnce(): void {
		this.lastStartMs = Date.now();
		this.setStatus('starting');
		const args = [
			'tunnel',
			'--config',
			this.opts.configPath,
			'--metrics',
			this.metricsAddr,
			'--no-autoupdate',
			'run',
			this.tunnelId,
		];
		this.logger.info({ bin: this.binPath, args }, 'Spawning cloudflared');
		const proc = spawn(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		this.child = proc;

		proc.stdout?.on('data', (chunk) => this.handleLog(chunk.toString()));
		proc.stderr?.on('data', (chunk) => this.handleLog(chunk.toString()));

		proc.on('error', (err) => {
			this.logger.error({ err }, 'cloudflared spawn error');
			this.setStatus('error', err.message);
		});

		proc.on('exit', (code, signal) => {
			this.child = null;
			this.stopHealthTimer();
			this.logger.warn({ code, signal }, 'cloudflared exited');
			if (this.intentionallyStopped) {
				this.setStatus('stopped');
				return;
			}
			// Auto-restart with backoff
			const uptimeMs = Date.now() - this.lastStartMs;
			if (uptimeMs > BACKOFF_RESET_AFTER_MS) {
				this.backoffMs = 1000;
			}
			this.setStatus('error', `exited with code=${code} signal=${signal}`);
			const wait = Math.min(this.backoffMs, MAX_BACKOFF_MS);
			this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
			this.logger.info({ wait_ms: wait }, 'Restarting after backoff');
			setTimeout(() => {
				if (!this.intentionallyStopped) this.spawnOnce();
			}, wait).unref();
		});

		// Begin health-polling after a short grace period
		setTimeout(() => this.startHealthTimer(), 5000).unref();
	}

	private handleLog(text: string): void {
		const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
		for (const line of lines) {
			this.logBuffer.push(line);
			if (this.logBuffer.length > LOG_BUFFER_LINES) this.logBuffer.shift();
			this.opts.onLog?.(line);
		}
	}

	private startHealthTimer(): void {
		if (this.healthTimer) return;
		this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_CHECK_INTERVAL_MS);
		this.healthTimer.unref?.();
	}

	private stopHealthTimer(): void {
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
	}

	private async pollHealth(): Promise<void> {
		if (!this.child) return;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
			const res = await fetch(`http://${this.metricsAddr}/ready`, { signal: controller.signal });
			clearTimeout(timer);
			if (res.ok) {
				if (this.status !== 'running') this.setStatus('running');
				return;
			}
			this.setStatus('error', `health check returned ${res.status}`);
		} catch (err) {
			// connection refused = still starting up; only mark error after a while
			if (this.status === 'starting') return;
			this.setStatus('error', `health check failed: ${(err as Error).message}`);
		}
	}

	private setStatus(s: Status, err?: string): void {
		if (this.status !== s) {
			this.status = s;
			this.opts.onStatusChange?.(s, err);
		}
	}
}
