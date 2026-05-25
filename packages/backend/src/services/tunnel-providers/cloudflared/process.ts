/**
 * cloudflared supervisor.
 *
 * Concrete ManagedProcess for the official cloudflared daemon. One child
 * per tunnel DB row, reloads with SIGHUP (cloudflared honours that to
 * re-read its config without dropping connections), polls /ready for
 * liveness.
 *
 * Pre-spawn hygiene:
 *   - On Linux, scan /proc for previous cloudflared processes that hold
 *     the metrics port we're about to bind. Kills them before the new
 *     spawn — covers cases where the supervisor lost track of a child
 *     (e.g. backoff-race leak across an upgrade) and the orphan was
 *     keeping `127.0.0.1:<port>` busy.
 *
 * Metrics-port collision avoidance:
 *   - Each tunnel gets its own port (caller derives it from tunnelDbId)
 *     so multi-tunnel installs don't fight over a single listener.
 */

import { readFile, readdir } from 'node:fs/promises';
import { ManagedProcess, type ManagedProcessOptions, type ProcessStatus } from '../../managed-process.js';

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_METRICS_PORT = 36500;

export interface CloudflaredProcessOptions extends ManagedProcessOptions {
	/** CF tunnel UUID — the positional arg for `cloudflared tunnel run`. */
	tunnelUuid: string;
	/** Path to the rendered config.yml on disk. */
	configPath: string;
	/**
	 * Metrics endpoint cloudflared exposes. Pass a unique value per tunnel
	 * to avoid "address already in use" when the install has more than one
	 * tunnel. Default `127.0.0.1:36500` (legacy single-tunnel layout).
	 */
	metricsAddr?: string;
}

/** Derive a unique metrics-port for a tunnel DB row. */
export function metricsAddrFor(tunnelDbId: number): string {
	// 36500 + id stays inside the safe user-port range for any reasonable
	// number of tunnels and keeps the numbers easy to recognise in logs.
	return `127.0.0.1:${DEFAULT_METRICS_PORT + tunnelDbId}`;
}

export class CloudflaredProcess extends ManagedProcess {
	private tunnelUuid: string;
	private configPath: string;
	private metricsAddr: string;

	constructor(opts: CloudflaredProcessOptions) {
		super({ ...opts, loggerName: opts.loggerName ?? 'cloudflared-process' });
		this.tunnelUuid = opts.tunnelUuid;
		this.configPath = opts.configPath;
		this.metricsAddr = opts.metricsAddr ?? `127.0.0.1:${DEFAULT_METRICS_PORT}`;
	}

	protected override defaultBinPath(): string {
		return 'cloudflared';
	}

	protected override buildArgs(): string[] {
		return [
			'tunnel',
			'--config',
			this.configPath,
			'--metrics',
			this.metricsAddr,
			'--no-autoupdate',
			'run',
			this.tunnelUuid,
		];
	}

	protected override async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		if (!this.child) return { status: 'error', reason: 'no child process' };
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
			const res = await fetch(`http://${this.metricsAddr}/ready`, { signal: controller.signal });
			clearTimeout(timer);
			if (res.ok) return { status: 'running' };
			return { status: 'error', reason: `health check returned ${res.status}` };
		} catch (err) {
			return { status: 'error', reason: (err as Error).message };
		}
	}

	/**
	 * Override start() to sweep for orphan cloudflared processes that
	 * could be holding our metrics port. Belt-and-braces — the supervisor
	 * race fix in ManagedProcess prevents *our own* leaks; this catches
	 * orphans from before the upgrade (or from a different installer that
	 * left cloudflared running in the container).
	 */
	override start(): void {
		// Fire and forget — we don't want to block spawn on a /proc walk.
		// Worst case the spawn fails to bind, exits, the next iteration's
		// sweep finds the orphan and clears it.
		void this.killOrphans();
		super.start();
	}

	private async killOrphans(): Promise<void> {
		if (process.platform !== 'linux') return;
		try {
			const entries = await readdir('/proc');
			const ownPid = String(process.pid);
			const childPid = this.child ? String(this.child.pid) : '';
			for (const entry of entries) {
				if (!/^\d+$/.test(entry)) continue;
				if (entry === ownPid || entry === childPid) continue;
				let cmdline: string;
				try {
					cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
				} catch {
					continue; // process disappeared mid-walk; harmless
				}
				// /proc/PID/cmdline is NUL-separated argv. We want
				// cloudflared binaries that mention OUR tunnel UUID.
				if (!cmdline.includes('cloudflared')) continue;
				if (!cmdline.includes(this.tunnelUuid)) continue;
				this.log.warn(
					{ pid: entry, tunnelUuid: this.tunnelUuid },
					'killing orphan cloudflared holding our tunnel'
				);
				try {
					process.kill(Number(entry), 'SIGKILL');
				} catch (err) {
					this.log.warn(
						{ pid: entry, err: (err as Error).message },
						'orphan kill failed (probably already dead)'
					);
				}
			}
		} catch (err) {
			// /proc unavailable (non-Linux, restricted container, etc.) —
			// log and move on. The supervisor race fix is the primary
			// safeguard; this is the safety net.
			this.log.debug({ err: (err as Error).message }, 'orphan sweep skipped');
		}
	}
}
