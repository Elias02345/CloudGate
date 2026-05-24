/**
 * cloudflared supervisor.
 *
 * Concrete ManagedProcess for the official cloudflared daemon. Spawns one
 * child per tunnel DB row, reloads with SIGHUP (cloudflared honours that
 * to re-read its config without dropping connections), polls /ready for
 * liveness.
 */

import { ManagedProcess, type ManagedProcessOptions, type ProcessStatus } from '../../managed-process.js';

const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export interface CloudflaredProcessOptions extends ManagedProcessOptions {
	/** CF tunnel UUID — the positional arg for `cloudflared tunnel run`. */
	tunnelUuid: string;
	/** Path to the rendered config.yml on disk. */
	configPath: string;
	/** Metrics endpoint cloudflared exposes (default 127.0.0.1:36500). */
	metricsAddr?: string;
}

export class CloudflaredProcess extends ManagedProcess {
	private tunnelUuid: string;
	private configPath: string;
	private metricsAddr: string;

	constructor(opts: CloudflaredProcessOptions) {
		super({ ...opts, loggerName: opts.loggerName ?? 'cloudflared-process' });
		this.tunnelUuid = opts.tunnelUuid;
		this.configPath = opts.configPath;
		this.metricsAddr = opts.metricsAddr ?? '127.0.0.1:36500';
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
}
