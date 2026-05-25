/**
 * cloudflared as a TunnelProvider.
 *
 * Wraps the existing cloudflared lifecycle (credentials file, config.yml
 * render, daemon spawn + SIGHUP reload) behind the provider interface.
 *
 * For cloudflared, hosts aren't "added" via API — they appear in the
 * rendered config the next time we reload. addHost() therefore does no
 * Cloudflare-side work; it just tells the caller which CNAME to publish.
 */

import { readdir, unlink, writeFile } from 'node:fs/promises';
import type { ProviderEdgeEndpoint } from '@cloudgate/shared';
import { dataPath } from '../../../config.js';
import { getDb } from '../../../db/db.js';
import { childLogger } from '../../../logger.js';
import { decryptJson } from '../../crypto.js';
import type { HostBinding, ProviderStatus, TunnelProvider } from '../types.js';
import { buildContext, writeConfig } from './config-writer.js';
import { CloudflaredProcess, metricsAddrFor } from './process.js';

/** UUID v4 in lowercase hex with dashes, as Cloudflare returns. */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = childLogger('cloudflared-provider');

interface TunnelRow {
	id: number;
	cloudflare_account_id: number;
	tunnel_id: string;
	name: string;
	account_tag: string | null;
	encrypted_tunnel_secret: Buffer | string;
	credentials_path: string | null;
	status: string;
}

interface CredentialsJson {
	AccountTag: string;
	TunnelID: string;
	TunnelName: string;
	TunnelSecret: string;
}

export class CloudflaredProvider implements TunnelProvider {
	readonly name = 'cloudflared' as const;
	readonly supports = ['http', 'https'] as const;

	private processes = new Map<number, CloudflaredProcess>();

	async start(tunnelDbId: number): Promise<void> {
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);

		// Tolerate missing credentials — common after a botched
		// upgrade or DB restore. We surface a clear "needs relink" error
		// and leave hosts attached to the tunnel so the user can recover
		// without losing their host configuration.
		let credsPath: string;
		try {
			credsPath = await this.ensureCredentialsFile(row);
		} catch (err) {
			const message = (err as Error).message;
			log.warn({ tunnelDbId, err: message }, 'cloudflared tunnel cannot start — credentials problem');
			await this.persistRelinkNeeded(tunnelDbId, message);
			return;
		}

		if (row.credentials_path !== credsPath) {
			await knex('tunnels').where({ id: row.id }).update({ credentials_path: credsPath });
		}

		try {
			const ctx = await buildContext({
				id: row.id,
				tunnel_id: row.tunnel_id,
				credentials_path: credsPath,
			});
			await writeConfig(ctx);
		} catch (err) {
			const message = (err as Error).message;
			log.warn({ tunnelDbId, err: message }, 'cloudflared config render failed');
			await this.persistRelinkNeeded(tunnelDbId, `config render failed: ${message}`);
			return;
		}

		let proc = this.processes.get(tunnelDbId);
		if (!proc) {
			proc = new CloudflaredProcess({
				id: row.tunnel_id,
				tunnelUuid: row.tunnel_id,
				configPath: dataPath('cloudflared', 'config.yml'),
				// Each tunnel binds its own metrics port so multi-tunnel
				// installs don't collide on 127.0.0.1:36500.
				metricsAddr: metricsAddrFor(tunnelDbId),
				onStatusChange: (s, err) => void this.persistStatus(tunnelDbId, s, err),
			});
			this.processes.set(tunnelDbId, proc);
		}
		proc.start();
	}

	async stop(tunnelDbId: number): Promise<void> {
		const proc = this.processes.get(tunnelDbId);
		if (!proc) return;
		await proc.stop();
		// CRITICAL: drop the process from the cache. Otherwise the next
		// start() reuses the cached instance — including its tunnelUuid
		// which was frozen at construction. After a Recreate (tunnel UUID
		// changes in the DB), reusing the old proc means cloudflared
		// spawns with the wrong UUID and CF refuses traffic to it,
		// producing the dreaded "live and running but page not found"
		// state. Fresh proc on next start picks up the new UUID.
		this.processes.delete(tunnelDbId);
	}

	async reload(tunnelDbId: number): Promise<void> {
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);
		const ctx = await buildContext({
			id: row.id,
			tunnel_id: row.tunnel_id,
			credentials_path: row.credentials_path ?? '',
		});
		await writeConfig(ctx);

		const proc = this.processes.get(tunnelDbId);
		if (proc) proc.reload();
	}

	status(tunnelDbId: number): ProviderStatus {
		const proc = this.processes.get(tunnelDbId);
		if (!proc) return 'stopped';
		return proc.currentStatus;
	}

	logs(tunnelDbId: number, maxLines = 200): string[] {
		const proc = this.processes.get(tunnelDbId);
		if (!proc) return [];
		return proc.getLogs(maxLines);
	}

	async addHost(tunnelDbId: number, host: HostBinding): Promise<ProviderEdgeEndpoint> {
		// cloudflared: host wiring is driven by the rendered config on the
		// next reload() — there's no per-host API call. We just tell the
		// caller which CNAME they should publish.
		if (host.protocol !== 'http' && host.protocol !== 'https') {
			throw new Error(`cloudflared provider does not support protocol '${host.protocol}'`);
		}
		const knex = getDb();
		const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
		if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);
		return {
			kind: 'cname',
			target: `${row.tunnel_id}.cfargotunnel.com`,
		};
	}

	async removeHost(_tunnelDbId: number, _hostId: number): Promise<void> {
		// Nothing CF-side: the next reload() rerenders config without this host.
		// host-deploy.undeployHost() handles the DNS record delete and then
		// calls reload() on the provider.
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async ensureCredentialsFile(row: TunnelRow): Promise<string> {
		if (!row.encrypted_tunnel_secret) {
			throw new Error(`tunnel ${row.id}: missing encrypted_tunnel_secret`);
		}
		if (!row.account_tag) {
			throw new Error(`tunnel ${row.id}: missing account_tag`);
		}
		const raw =
			typeof row.encrypted_tunnel_secret === 'string'
				? row.encrypted_tunnel_secret
				: row.encrypted_tunnel_secret.toString('utf8');
		const secret = decryptJson<{ type: 'tunnel'; secret: string }>(raw);
		const payload: CredentialsJson = {
			AccountTag: row.account_tag,
			TunnelID: row.tunnel_id,
			TunnelName: row.name,
			TunnelSecret: secret.secret,
		};
		const outPath = dataPath('cloudflared', `${row.tunnel_id}.json`);
		await writeFile(outPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });

		// Clean up cred files for OTHER tunnel UUIDs we know about. After
		// a Recreate the old <OLD_UUID>.json stays on disk and cloudflared
		// can accidentally use it (it accepts the file path from config.yml
		// but also looks in default locations). Only purge files whose
		// names look like a UUID — never touch user-managed *.json.
		void this.purgeStaleCredFiles(row.tunnel_id).catch((err) => {
			log.debug({ err: (err as Error).message }, 'stale cred cleanup skipped');
		});

		return outPath;
	}

	private async purgeStaleCredFiles(currentUuid: string): Promise<void> {
		const knex = getDb();
		// Build set of UUIDs we still care about — every cloudflared tunnel
		// in the DB. We never delete a file that belongs to a known tunnel.
		const rows = await knex<{ tunnel_id: string }>('tunnels')
			.where('provider', 'cloudflared')
			.select('tunnel_id');
		const keep = new Set(rows.map((r) => r.tunnel_id).filter(Boolean));
		keep.add(currentUuid);

		const dir = dataPath('cloudflared');
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.endsWith('.json')) continue;
			const uuid = entry.slice(0, -'.json'.length);
			if (!UUID_RX.test(uuid)) continue; // not one of ours
			if (keep.has(uuid)) continue;
			try {
				await unlink(`${dir}/${entry}`);
				log.info({ removed: entry }, 'removed stale cloudflared cred file');
			} catch (err) {
				log.warn({ err: (err as Error).message, entry }, 'stale cred unlink failed');
			}
		}
	}

	private async persistStatus(tunnelDbId: number, status: ProviderStatus, err?: string): Promise<void> {
		const knex = getDb();
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ status, last_status_at: new Date().toISOString() });
		if (err) {
			log.warn({ tunnelDbId, status, err }, 'Tunnel status changed');
			await this.recordError(tunnelDbId, err);
		} else {
			log.info({ tunnelDbId, status }, 'Tunnel status changed');
			await this.recordError(tunnelDbId, null);
		}
	}

	private async persistRelinkNeeded(tunnelDbId: number, reason: string): Promise<void> {
		const knex = getDb();
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ status: 'error', last_status_at: new Date().toISOString() });
		await this.recordError(
			tunnelDbId,
			`Tunnel cannot start: ${reason}. Use "Re-link" to re-attach this tunnel to a Cloudflare account without losing its hosts.`
		);
	}

	private async recordError(tunnelDbId: number, errorOrNull: string | null): Promise<void> {
		const knex = getDb();
		const row = await knex<{ provider_meta: string | null }>('tunnels')
			.where({ id: tunnelDbId })
			.select('provider_meta')
			.first();
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(row?.provider_meta || '{}');
		} catch {
			meta = {};
		}
		if (errorOrNull === null) {
			meta.last_error = undefined;
			meta.last_error_at = undefined;
		} else {
			meta.last_error = errorOrNull;
			meta.last_error_at = new Date().toISOString();
		}
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ provider_meta: JSON.stringify(meta) });
	}
}
