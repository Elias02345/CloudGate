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

import { writeFile } from 'node:fs/promises';
import type { ProviderEdgeEndpoint } from '@cloudgate/shared';
import { dataPath } from '../../../config.js';
import { getDb } from '../../../db/db.js';
import { childLogger } from '../../../logger.js';
import { decryptJson } from '../../crypto.js';
import type { HostBinding, ProviderStatus, TunnelProvider } from '../types.js';
import { buildContext, writeConfig } from './config-writer.js';
import { CloudflaredProcess } from './process.js';

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

		const credsPath = await this.ensureCredentialsFile(row);
		if (row.credentials_path !== credsPath) {
			await knex('tunnels').where({ id: row.id }).update({ credentials_path: credsPath });
		}

		const ctx = await buildContext({
			id: row.id,
			tunnel_id: row.tunnel_id,
			credentials_path: credsPath,
		});
		await writeConfig(ctx);

		let proc = this.processes.get(tunnelDbId);
		if (!proc) {
			proc = new CloudflaredProcess({
				id: row.tunnel_id,
				tunnelUuid: row.tunnel_id,
				configPath: dataPath('cloudflared', 'config.yml'),
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
		return outPath;
	}

	private async persistStatus(tunnelDbId: number, status: ProviderStatus, err?: string): Promise<void> {
		const knex = getDb();
		await knex('tunnels')
			.where({ id: tunnelDbId })
			.update({ status, last_status_at: new Date().toISOString() });
		if (err) log.warn({ tunnelDbId, status, err }, 'Tunnel status changed');
		else log.info({ tunnelDbId, status }, 'Tunnel status changed');
	}
}
