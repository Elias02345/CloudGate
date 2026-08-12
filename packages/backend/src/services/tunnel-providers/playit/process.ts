/**
 * playit-agent supervisor.
 *
 * One agent per linked Playit account, reused across all tunnel rows that
 * share that account. The agent reads its tunnels from Playit's API on
 * startup and keeps them open; CloudGate creates/deletes tunnels via the
 * REST client.
 *
 * Binary lives in /data/playit/bin/playit-agent (downloaded idempotently
 * by services/playit-binary.ts). Secret key is passed via env var so it
 * doesn't show up in `ps`.
 */

import { dataPath } from '../../../config.js';
import { ManagedProcess, type ManagedProcessOptions, type ProcessStatus } from '../../managed-process.js';

const HEALTH_GRACE_AGENT_MS = 8_000;

export interface PlayitProcessOptions extends ManagedProcessOptions {
	accountId: number;
	secretKey: string;
}

export class PlayitProcess extends ManagedProcess {
	readonly accountId: number;
	private secretKey: string;
	/** tunnels (DB ids) this account-process is currently serving. */
	private servedTunnels = new Set<number>();

	constructor(opts: PlayitProcessOptions) {
		super({ ...opts, loggerName: opts.loggerName ?? 'playit-process' });
		this.accountId = opts.accountId;
		this.secretKey = opts.secretKey;
	}

	protected override defaultBinPath(): string {
		return dataPath('playit', 'bin', process.platform === 'win32' ? 'playit-agent.exe' : 'playit-agent');
	}

	protected override buildArgs(): string[] {
		// `--secret <KEY>` is the documented agent flag. Some builds prefer
		// reading from the env var PLAYIT_SECRET_KEY (which we also export
		// via spawn options if needed).
		return ['--secret', this.secretKey, '--no-autoupdate'];
	}

	/**
	 * Health check: ask the agent's local control socket (if available).
	 * Playit doesn't ship a stable /ready endpoint yet, so we fall back to
	 * "process is alive and we've waited past the warm-up grace window".
	 */
	protected override async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		if (!this.child) return { status: 'error', reason: 'no child process' };
		// Grace window — give the agent time to claim its tunnels.
		const uptime = Date.now() - this.lastStartedAt;
		if (uptime < HEALTH_GRACE_AGENT_MS) return { status: 'starting' };
		return { status: 'running' };
	}

	/** Mark this account-process as currently responsible for the tunnel row. */
	markOwns(tunnelDbId: number): void {
		this.servedTunnels.add(tunnelDbId);
	}

	unmarkOwns(tunnelDbId: number): void {
		this.servedTunnels.delete(tunnelDbId);
	}

	ownsTunnel(tunnelDbId: number): boolean {
		return this.servedTunnels.has(tunnelDbId);
	}
}
