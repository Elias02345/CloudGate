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
 *  - addHost() creates (or reuses) a playit tunnel pointing at the host's
 *    origin, waits for playit to assign a public address, and returns it:
 *    the free playit address (e.g. name.tun.ply.gg:port) as host_port, or
 *    an SRV record on the user's Cloudflare zone for Minecraft Java.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ProviderEdgeEndpoint } from '@cloudgate/shared';
import { getDb } from '../../../db/db.js';
import { childLogger } from '../../../logger.js';
import { decryptJson } from '../../crypto.js';
import type { HostBinding, ProviderStatus, TunnelProvider } from '../types.js';
import {
	type PlayitAllocation,
	PlayitApiError,
	type PlayitClient,
	type PlayitTunnelType,
	createPlayitClient,
} from './client.js';
import { PlayitProcess } from './process.js';

const log = childLogger('playit-provider');

/** Host presets that map onto a dedicated playit tunnel type. */
const PLAYIT_TUNNEL_TYPES: Record<string, PlayitTunnelType> = {
	minecraft_java: 'minecraft-java',
	minecraft_bedrock: 'minecraft-bedrock',
};

const ALLOCATION_WAIT_MS = 30_000;
const ALLOCATION_POLL_MS = 2_000;
const AGENT_CONNECT_WAIT_MS = 45_000;
const AGENT_CONNECT_POLL_MS = 3_000;

/** playit wants an IP for the origin; resolve container/host names here. */
async function resolveLocalIp(host: string): Promise<string> {
	const bare = host.replace(/^\[|\]$/g, '');
	if (isIP(bare)) return bare;
	return (await lookup(bare)).address;
}

/** A new tunnel starts 'pending' until playit assigns it a public address. */
async function waitForAllocation(client: PlayitClient, tunnelId: string): Promise<PlayitAllocation> {
	const deadline = Date.now() + ALLOCATION_WAIT_MS;
	for (;;) {
		const tunnel = (await client.listTunnels(tunnelId)).tunnels[0];
		if (!tunnel) throw new Error(`playit tunnel ${tunnelId} disappeared`);
		if (tunnel.allocation) return tunnel.allocation;
		if (tunnel.disabled_reason) {
			throw new Error(`playit disabled the tunnel: ${tunnel.disabled_reason}`);
		}
		if (Date.now() > deadline) {
			throw new Error('playit is still assigning an address to this tunnel; redeploy the host in a minute');
		}
		await new Promise((r) => setTimeout(r, ALLOCATION_POLL_MS));
	}
}

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
		const { secret, meta } = await this.loadTunnelContext(tunnelDbId);
		const client = createPlayitClient(secret);
		const localIp = await resolveLocalIp(host.forward_host);
		const tunnelType = PLAYIT_TUNNEL_TYPES[host.host_type ?? ''] ?? null;

		// Idempotent: deployHost runs again on every edit, toggle and
		// redeploy. Reuse the playit tunnel while it still points at the same
		// origin; otherwise each redeploy would burn one of the few free ports.
		const previous = meta.hosts?.[String(host.id)];
		let tunnelId: string | null = null;
		if (previous) {
			const existing = (await client.listTunnels(previous.tunnel_uuid)).tunnels[0];
			if (
				existing &&
				existing.port_type === host.protocol &&
				existing.local_ip === localIp &&
				existing.local_port === host.forward_port &&
				existing.tunnel_type === tunnelType
			) {
				tunnelId = existing.id;
			} else if (existing) {
				await client.deleteTunnel(existing.id);
			}
		}
		if (!tunnelId) {
			const { agent_id } = await client.runData();
			const input = {
				// playit tunnel names must be ASCII and short.
				name: host.hostname.replace(/[^ -~]/g, '').slice(0, 30),
				tunnel_type: tunnelType,
				port_type: host.protocol,
				agent_id,
				local_ip: localIp,
				local_port: host.forward_port,
			};
			// playit refuses tunnels (AgentVersionTooOld) until the agent has
			// connected and reported its version — true for every freshly
			// claimed agent. Start it and retry while it connects.
			const deadline = Date.now() + AGENT_CONNECT_WAIT_MS;
			for (;;) {
				try {
					tunnelId = await client.createTunnel(input);
					break;
				} catch (err) {
					if (
						!(err instanceof PlayitApiError) ||
						err.code !== 'AgentVersionTooOld' ||
						Date.now() > deadline
					) {
						throw err;
					}
					await this.start(tunnelDbId);
					await new Promise((r) => setTimeout(r, AGENT_CONNECT_POLL_MS));
				}
			}
			// Persist right away so a failed allocation wait below does not
			// orphan the tunnel on the next deploy.
			await this.persistHostAssignment(tunnelDbId, host.id, {
				tunnel_uuid: tunnelId,
				assigned_host: '',
				assigned_port: 0,
			});
		}

		const alloc = await waitForAllocation(client, tunnelId);
		await this.persistHostAssignment(tunnelDbId, host.id, {
			tunnel_uuid: tunnelId,
			assigned_host: alloc.assigned_domain,
			assigned_port: alloc.port_start,
		});

		// Java Edition reads SRV records, so with a zone the host's own
		// hostname works without a port. Bedrock and raw TCP/UDP clients do
		// not, and without a zone players use playit's free address directly.
		if (host.host_type === 'minecraft_java' && host.has_zone) {
			return {
				kind: 'srv',
				service: '_minecraft',
				proto: '_tcp',
				target: alloc.ip_hostname,
				port: alloc.port_start,
			};
		}
		return { kind: 'host_port', target: alloc.assigned_domain, port: alloc.port_start };
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
	): Promise<{ row: TunnelRow; accountId: number; secret: string; meta: ProviderMeta }> {
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
		return { row, accountId: meta.playit_account_id, secret: secret.secret, meta };
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
