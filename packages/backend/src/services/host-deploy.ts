/**
 * Host deployment orchestration.
 *
 * The "headline" flow: user adds hostname → backend creates DNS CNAME via CF API
 * → re-renders tunnel config → reloads cloudflared. SSE event published on success.
 */

import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptCredentials } from './cf-account.js';
import { CloudflareApiError, clientFor } from './cloudflare-client.js';
import { publish } from './events.js';
import { removeHostConfig, writeHostConfig } from './nginx-config.js';
import { reloadTunnel } from './tunnel-manager.js';

const log = childLogger('host-deploy');

interface HostRow {
	id: number;
	tunnel_id: number | null;
	cf_zone_id: number | null;
	mode: string;
	hostname: string;
	dns_record_id: string | null;
}

/**
 * Deploy a host:
 *  1) If mode=cloudflare_tunnel: create CNAME pointing to <tunnel-uuid>.cfargotunnel.com
 *  2) Re-render cloudflared config + SIGHUP reload
 *  3) Persist dns_record_id + last_deployed_at
 *  4) Publish SSE event
 */
export async function deployHost(hostId: number): Promise<void> {
	const knex = getDb();
	const host = await knex<HostRow>('proxy_hosts').where({ id: hostId }).first();
	if (!host) throw new Error(`host ${hostId} not found`);

	if (host.mode === 'local_nginx') {
		// Local nginx reverse-proxy path
		const full = await knex<{
			id: number;
			hostname: string;
			forward_scheme: string;
			forward_host: string;
			forward_port: number;
			path_prefix: string;
			tls_options: string;
		}>('proxy_hosts')
			.where({ id: hostId })
			.first();
		if (!full) throw new Error(`host ${hostId} not found`);
		let tls: { no_tls_verify?: boolean } = {};
		try {
			tls = typeof full.tls_options === 'string' ? JSON.parse(full.tls_options) : {};
		} catch {
			tls = {};
		}
		try {
			await writeHostConfig({
				id: full.id,
				hostname: full.hostname,
				forward_scheme: full.forward_scheme,
				forward_host: full.forward_host,
				forward_port: full.forward_port,
				path_prefix: full.path_prefix,
				no_tls_verify: Boolean(tls.no_tls_verify),
			});
			await knex('proxy_hosts')
				.where({ id: hostId })
				.update({ last_deployed_at: new Date().toISOString(), last_error: null });
			publish('host.deployed', { id: hostId, mode: 'local_nginx', hostname: full.hostname });
			log.info({ id: hostId, hostname: full.hostname }, 'local_nginx host deployed');
		} catch (err) {
			const msg = (err as Error).message;
			await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
			publish('host.deploy_failed', { id: hostId, error: msg });
			throw err;
		}
		return;
	}

	if (!host.tunnel_id || !host.cf_zone_id) {
		throw new Error('cloudflare_tunnel mode requires tunnel_id and cf_zone_id');
	}

	const tunnelRow = await knex<{ id: number; tunnel_id: string; cloudflare_account_id: number }>('tunnels')
		.where({ id: host.tunnel_id })
		.first();
	if (!tunnelRow) throw new Error('tunnel not found');

	const zoneRow = await knex<{ id: number; zone_id: string; cloudflare_account_id: number }>('cf_zones')
		.where({ id: host.cf_zone_id })
		.first();
	if (!zoneRow) throw new Error('zone not found');

	if (tunnelRow.cloudflare_account_id !== zoneRow.cloudflare_account_id) {
		throw new Error('tunnel and zone belong to different Cloudflare accounts');
	}

	const accountRow = await knex<{ id: number; encrypted_credentials: Buffer | string; auth_type: string }>(
		'cloudflare_accounts'
	)
		.where({ id: tunnelRow.cloudflare_account_id })
		.first();
	if (!accountRow) throw new Error('cf account not found');

	const creds = decryptCredentials(accountRow);
	if (creds.type !== 'api_token') {
		throw new Error('OAuth deploy unsupported in M1');
	}
	const cf = clientFor(creds.token);

	try {
		// Create / update CNAME — pointing to <tunnel-uuid>.cfargotunnel.com, proxied
		const target = `${tunnelRow.tunnel_id}.cfargotunnel.com`;
		let dnsRecordId = host.dns_record_id;

		if (dnsRecordId) {
			// Update existing record (in case of edits)
			// biome-ignore lint/suspicious/noExplicitAny: CF SDK types
			await (cf.dns.records as any).update(dnsRecordId, {
				zone_id: zoneRow.zone_id,
				type: 'CNAME',
				name: host.hostname,
				content: target,
				proxied: true,
				ttl: 1,
			});
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: CF SDK types
			const created = (await (cf.dns.records as any).create({
				zone_id: zoneRow.zone_id,
				type: 'CNAME',
				name: host.hostname,
				content: target,
				proxied: true,
				ttl: 1,
			})) as { id: string };
			dnsRecordId = created.id;
		}

		await knex('proxy_hosts').where({ id: hostId }).update({
			dns_record_id: dnsRecordId,
			last_deployed_at: new Date().toISOString(),
			last_error: null,
		});

		// Re-render config + reload daemon
		await reloadTunnel(host.tunnel_id);

		publish('host.deployed', { id: hostId, hostname: host.hostname });
		log.info({ id: hostId, hostname: host.hostname }, 'Host deployed');
	} catch (err) {
		const msg = err instanceof CloudflareApiError ? err.message : (err as Error).message;
		await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
		publish('host.deploy_failed', { id: hostId, hostname: host.hostname, error: msg });
		throw err;
	}
}

/**
 * Undeploy: delete DNS record at CF, re-render config (drops ingress).
 */
export async function undeployHost(hostId: number): Promise<void> {
	const knex = getDb();
	const host = await knex<HostRow>('proxy_hosts').where({ id: hostId }).first();
	if (!host) return; // already gone

	if (host.mode === 'cloudflare_tunnel' && host.dns_record_id && host.cf_zone_id) {
		const zoneRow = await knex<{ zone_id: string; cloudflare_account_id: number }>('cf_zones')
			.where({ id: host.cf_zone_id })
			.first();
		if (zoneRow) {
			const accountRow = await knex<{ encrypted_credentials: Buffer | string; auth_type: string }>(
				'cloudflare_accounts'
			)
				.where({ id: zoneRow.cloudflare_account_id })
				.first();
			if (accountRow) {
				try {
					const creds = decryptCredentials(accountRow);
					if (creds.type === 'api_token') {
						const cf = clientFor(creds.token);
						// biome-ignore lint/suspicious/noExplicitAny: CF SDK types
						await (cf.dns.records as any).delete(host.dns_record_id, { zone_id: zoneRow.zone_id });
					}
				} catch (err) {
					log.warn({ err: (err as Error).message }, 'DNS record delete failed (continuing)');
				}
			}
		}
	}

	if (host.mode === 'local_nginx') {
		try {
			await removeHostConfig(host.id);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'local_nginx undeploy failed');
		}
	}

	if (host.tunnel_id) {
		try {
			await reloadTunnel(host.tunnel_id);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'tunnel reload during undeploy failed');
		}
	}
}
