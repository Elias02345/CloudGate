/**
 * Playit.gg tunnel provider — supports raw TCP/UDP services (Minecraft Java
 * 25565, Bedrock 19132, SSH, custom game servers, etc.) that Cloudflare
 * Tunnel can't deliver to vanilla clients on the free plan.
 *
 * Architecture:
 *  - One `playit-agent` child process per linked Playit account, supervised
 *    by ManagedProcess.
 *  - Each "tunnel" row points at a Playit account; tunnels group hosts by
 *    account so the agent owns them.
 *  - addHost() calls Playit's REST API to create a port mapping, persists
 *    the assigned external host:port in proxy_hosts.edge_endpoint, and
 *    returns the appropriate edge endpoint for DNS publishing (SRV record
 *    on the user's Cloudflare zone for Java; bare host:port for Bedrock).
 *
 * Stub: full implementation lives alongside client.ts + process.ts and is
 * wired up once the binary + REST client land. Keeping this skeleton so
 * the registry can resolve 'playit' without crashing.
 */

import type { ProviderEdgeEndpoint } from '@cloudgate/shared';
import { getDb } from '../../../db/db.js';
import { childLogger } from '../../../logger.js';
import { decryptJson } from '../../crypto.js';
import type { HostBinding, ProviderStatus, TunnelProvider } from '../types.js';
import { createPlayitClient } from './client.js';
import { PlayitProcess } from './process.js';

const log = childLogger('playit-provider');

interface TunnelRow {
	id: number;
	tunnel_id: string;
	name: string;
	provider: string;
	provider_meta: string;
	status: string;
}

interface PlayitAccountRow {
	id: number;
	encrypted_secret_key: Buffer | string;
}

interface ProviderMeta {
	playit_account_id?: number;
	/** Per-host: { [hostDbId]: { tunnel_uuid, assigned_host, assigned_port } } */
	hosts?: Record<string, { tunnel_uuid: string; assigned_host: string; assigned_port: number }>;
}

export class PlayitProvider implements TunnelProvider {
	readonly name = 'playit' as const;
	readonly supports = ['tcp', 'udp'] as const;

	/** One agent process per linked Playit account. */
	private processes = new Map<number, PlayitProcess>();

	async start(tunnelDbId: number): Promise<void> {
		const { row, accountId, secret } = await this.loadTunnelContext(tunnelDbId);
		let proc = this.processes.get(accountId);
		if (!proc) {
			proc = new PlayitProcess({
				id: `playit-account-${accountId}`,
				accountId,
				secretKey: secret,
				onStatusChange: (s, err) => void this.persistStatus(row.id, s, err),
			});
			this.processes.set(accountId, proc);
		}
		proc.markOwns(tunnelDbId);
		proc.start();
	}

	async stop(tunnelDbId: number): Promise<void> {
		const { accountId } = await this.loadTunnelContext(tunnelDbId);
		const proc = this.processes.get(accountId);
		if (!proc) return;
		// Only stop the shared agent if no other tunnel uses this account.
		const knex = getDb();
		const others = await knex<TunnelRow>('tunnels')
			.where('provider', 'playit')
			.whereNot('id', tunnelDbId)
			.select('id', 'provider_meta');
		const stillInUse = others.some((o) => {
			try {
				const meta = JSON.parse(o.provider_meta || '{}') as ProviderMeta;
				return meta.playit_account_id === accountId;
			} catch {
				return false;
			}
		});
		if (!stillInUse) {
			await proc.stop();
			this.processes.delete(accountId);
		}
	}

	async reload(tunnelDbId: number): Promise<void> {
		// Playit re-syncs port mappings via REST; the agent picks up changes
		// from the API on its next poll. We don't need to signal the process.
		log.debug({ tunnelDbId }, 'reload (playit) — no-op; agent re-polls API');
	}

	status(tunnelDbId: number): ProviderStatus {
		// Best-effort: ask the linked agent. If we don't know the account
		// yet (e.g. tunnel never started), report 'stopped'.
		// This is sync (interface contract) so we have to look at the in-mem map.
		for (const proc of this.processes.values()) {
			if (proc.ownsTunnel(tunnelDbId)) return proc.currentStatus;
		}
		return 'stopped';
	}

	logs(tunnelDbId: number, maxLines = 200): string[] {
		for (const proc of this.processes.values()) {
			if (proc.ownsTunnel(tunnelDbId)) return proc.getLogs(maxLines);
		}
		return [];
	}

	async addHost(tunnelDbId: number, host: HostBinding): Promise<ProviderEdgeEndpoint> {
		if (host.protocol !== 'tcp' && host.protocol !== 'udp') {
			throw new Error(`playit provider does not support protocol '${host.protocol}'`);
		}
		const { secret } = await this.loadTunnelContext(tunnelDbId);
		const client = createPlayitClient(secret);
		const result = await client.createTunnel({
			name: host.hostname,
			protocol: host.protocol,
			local_host: host.forward_host,
			local_port: host.forward_port,
		});

		// Persist the assignment so future reloads + restarts keep the same
		// external endpoint (and so we can show it in the UI).
		await this.persistHostAssignment(tunnelDbId, host.id, {
			tunnel_uuid: result.tunnel_uuid,
			assigned_host: result.assigned_host,
			assigned_port: result.assigned_port,
		});

		// Java Edition uses SRV. Bedrock can't read SRV — emit host_port so
		// the UI shows the exact "Server Address" string the player must paste.
		const useSrv = host.protocol === 'tcp';
		if (useSrv) {
			return {
				kind: 'srv',
				service: '_minecraft',
				proto: '_tcp',
				target: result.assigned_host,
				port: result.assigned_port,
			};
		}
		return {
			kind: 'host_port',
			target: result.assigned_host,
			port: result.assigned_port,
		};
	}

	async removeHost(tunnelDbId: number, hostId: number): Promise<void> {
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) return;
		let meta: ProviderMeta = {};
		try {
			meta = JSON.parse(row.provider_meta || '{}') as ProviderMeta;
		} catch {
			meta = {};
		}
		const entry = meta.hosts?.[String(hostId)];
		if (!entry) return;
		try {
			const { secret } = await this.loadTunnelContext(tunnelDbId);
			const client = createPlayitClient(secret);
			await client.deleteTunnel(entry.tunnel_uuid);
		} catch (err) {
			log.warn({ err: (err as Error).message, hostId }, 'Playit tunnel delete failed (continuing)');
		}
		if (meta.hosts) delete meta.hosts[String(hostId)];
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ provider_meta: JSON.stringify(meta) });
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async loadTunnelContext(
		tunnelDbId: number
	): Promise<{ row: TunnelRow; accountId: number; secret: string }> {
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);
		let meta: ProviderMeta = {};
		try {
			meta = JSON.parse(row.provider_meta || '{}') as ProviderMeta;
		} catch {
			meta = {};
		}
		if (!meta.playit_account_id) {
			throw new Error(`tunnel ${tunnelDbId} has no playit_account_id in provider_meta`);
		}
		const account = await knex<PlayitAccountRow>('playit_accounts')
			.where({ id: meta.playit_account_id })
			.first();
		if (!account) {
			throw new Error(`playit_account ${meta.playit_account_id} not found`);
		}
		const raw =
			typeof account.encrypted_secret_key === 'string'
				? account.encrypted_secret_key
				: account.encrypted_secret_key.toString('utf8');
		const secret = decryptJson<{ type: 'playit'; secret: string }>(raw);
		return { row, accountId: meta.playit_account_id, secret: secret.secret };
	}

	private async persistHostAssignment(
		tunnelDbId: number,
		hostDbId: number,
		entry: { tunnel_uuid: string; assigned_host: string; assigned_port: number }
	): Promise<void> {
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) return;
		let meta: ProviderMeta = {};
		try {
			meta = JSON.parse(row.provider_meta || '{}') as ProviderMeta;
		} catch {
			meta = {};
		}
		if (!meta.hosts) meta.hosts = {};
		meta.hosts[String(hostDbId)] = entry;
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ provider_meta: JSON.stringify(meta) });
	}

	private async persistStatus(tunnelDbId: number, status: ProviderStatus, err?: string): Promise<void> {
		const knex = getDb();
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ status, last_status_at: new Date().toISOString() });
		if (err) log.warn({ tunnelDbId, status, err }, 'Playit tunnel status changed');
	}
}
