/**
 * Abstract supervisor for a single long-lived child process.
 *
 * Owns the boring parts of process lifecycle so concrete tunnel providers
 * (cloudflared, Playit, future ngrok/FRP) can subclass and only describe
 * the bits that differ: which binary, which args, how to check health,
 * and how to reload (SIGHUP vs API call vs full restart).
 *
 * Responsibilities owned here:
 *   - spawn / kill (SIGTERM → SIGKILL fallback after 5s)
 *   - stdout/stderr capture into a ring buffer
 *   - status FSM: stopped → starting → running → error → stopped
 *   - exponential-backoff auto-restart on crash
 *   - periodic health check that promotes starting → running
 *
 * Concurrency guarantee: lifecycle calls (start/stop/reload) are not
 * re-entrant — caller should serialise them per instance.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { Logger as PinoLogger } from 'pino';
import { childLogger } from '../logger.js';

const HEALTH_CHECK_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_RESET_AFTER_MS = 60_000;
const LOG_BUFFER_LINES = 1000;
const HEALTH_GRACE_MS = 5_000;
const KILL_FORCE_TIMEOUT_MS = 5_000;

export type ProcessStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface ManagedProcessOptions {
	/** Stable identifier used in log fields. */
	id: string;
	/** Path to the binary to exec (default: looked up via PATH). */
	binPath?: string;
	/** Optional sub-logger name. */
	loggerName?: string;
	/** Status transition callback (useful for persistence). */
	onStatusChange?: (status: ProcessStatus, err?: string) => void;
	/** Per-line stdout/stderr callback (in addition to the ring buffer). */
	onLog?: (line: string) => void;
}

/**
 * Abstract — subclasses MUST override `buildArgs()` and SHOULD override
 * `checkHealth()`. Default health check returns `running` immediately after
 * the grace period — good enough for processes that don't expose a probe.
 */
export abstract class ManagedProcess {
	readonly id: string;
	protected readonly log: PinoLogger;
	protected readonly binPath: string;
	protected child: ChildProcess | null = null;
	protected status: ProcessStatus = 'stopped';
	private opts: ManagedProcessOptions;
	private intentionallyStopped = false;
	private healthTimer: NodeJS.Timeout | null = null;
	private backoffMs = 1_000;
	private lastStartMs = 0;
	private logBuffer: string[] = [];

	constructor(opts: ManagedProcessOptions) {
		this.opts = opts;
		this.id = opts.id;
		this.binPath = opts.binPath ?? this.defaultBinPath();
		this.log = childLogger(opts.loggerName ?? 'managed-process');
	}

	get currentStatus(): ProcessStatus {
		return this.status;
	}

	/** Wall-clock epoch ms of the most recent spawn (0 if never spawned). */
	protected get lastStartedAt(): number {
		return this.lastStartMs;
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
			}, KILL_FORCE_TIMEOUT_MS).unref();
		});
	}

	/**
	 * Default reload: SIGHUP. Subclasses override for API-based reloads
	 * (e.g. Playit agent doesn't honour SIGHUP — it reloads via REST).
	 */
	reload(): void | Promise<void> {
		if (!this.child || this.status !== 'running') {
			this.log.warn({ id: this.id }, 'reload requested but process not running');
			return;
		}
		try {
			this.child.kill('SIGHUP');
			this.log.info({ id: this.id }, 'Sent SIGHUP for config reload');
		} catch (err) {
			this.log.warn({ err: (err as Error).message }, 'SIGHUP failed');
		}
	}

	// -----------------------------------------------------------------------
	// Subclass hooks
	// -----------------------------------------------------------------------

	/** Default binary lookup — overridden when the binary lives in /data. */
	protected defaultBinPath(): string {
		return this.constructor.name.toLowerCase();
	}

	/** Build the argv array passed to spawn(). MUST be implemented. */
	protected abstract buildArgs(): string[];

	/**
	 * Subclass health check. Returns 'running' when the process is ready,
	 * 'starting' if still warming up, or 'error' (with reason) if dead.
	 * Default: any live PID counts as running.
	 */
	protected async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		if (this.child) return { status: 'running' };
		return { status: 'error', reason: 'no child process' };
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private spawnOnce(): void {
		this.lastStartMs = Date.now();
		this.setStatus('starting');
		const args = this.buildArgs();
		this.log.info({ bin: this.binPath, args, id: this.id }, 'Spawning managed process');
		const proc = spawn(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		this.child = proc;

		proc.stdout?.on('data', (chunk) => this.handleLog(chunk.toString()));
		proc.stderr?.on('data', (chunk) => this.handleLog(chunk.toString()));

		proc.on('error', (err) => {
			this.log.error({ err: err.message, id: this.id }, 'Spawn error');
			this.setStatus('error', err.message);
		});

		proc.on('exit', (code, signal) => {
			this.child = null;
			this.stopHealthTimer();
			this.log.warn({ code, signal, id: this.id }, 'Process exited');
			if (this.intentionallyStopped) {
				this.setStatus('stopped');
				return;
			}
			const uptimeMs = Date.now() - this.lastStartMs;
			if (uptimeMs > BACKOFF_RESET_AFTER_MS) this.backoffMs = 1_000;
			this.setStatus('error', `exited with code=${code} signal=${signal}`);
			const wait = Math.min(this.backoffMs, MAX_BACKOFF_MS);
			this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
			this.log.info({ wait_ms: wait, id: this.id }, 'Restarting after backoff');
			setTimeout(() => {
				if (!this.intentionallyStopped) this.spawnOnce();
			}, wait).unref();
		});

		setTimeout(() => this.startHealthTimer(), HEALTH_GRACE_MS).unref();
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
			const result = await this.checkHealth();
			if (result.status === 'running' && this.status !== 'running') {
				this.setStatus('running');
				return;
			}
			if (result.status === 'error') {
				// Connection refused during warm-up is normal; we only flip
				// to error if we were already past warm-up.
				if (this.status === 'starting') return;
				this.setStatus('error', result.reason);
			}
		} catch (err) {
			if (this.status === 'starting') return;
			this.setStatus('error', `health check failed: ${(err as Error).message}`);
		}
	}

	protected setStatus(s: ProcessStatus, err?: string): void {
		if (this.status !== s) {
			this.status = s;
			this.opts.onStatusChange?.(s, err);
		}
	}
}
