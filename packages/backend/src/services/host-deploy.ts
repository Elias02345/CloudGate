/**
 * Host deployment orchestration.
 *
 * Dispatches to the right TunnelProvider based on the tunnel row's
 * `provider` column. Providers tell us which kind of edge endpoint to
 * publish (CNAME / SRV / bare host:port) — we write the DNS record to
 * the user's Cloudflare zone accordingly.
 */

import type { HostProtocol, ProviderEdgeEndpoint, TunnelProviderName } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptCredentials } from './cf-account.js';
import {
	CloudflareApiError,
	deleteDnsRecord,
	upsertCnameRecord,
	upsertSrvRecord,
} from './cloudflare-client.js';
import { verifyDns } from './dns-verify.js';
import { publish } from './events.js';
import { removeHostConfig, writeHostConfig } from './nginx-config.js';
import { getProvider } from './tunnel-providers/index.js';
import type { HostBinding } from './tunnel-providers/types.js';
import { probeUpstream } from './upstream-probe.js';

const log = childLogger('host-deploy');

interface HostRow {
	id: number;
	tunnel_id: number | null;
	cf_zone_id: number | null;
	mode: string;
	protocol: string;
	hostname: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	path_prefix: string;
	tls_options: string;
	dns_record_id: string | null;
	edge_endpoint: string | null;
}

interface TunnelRow {
	id: number;
	tunnel_id: string;
	provider: string | null;
	cloudflare_account_id: number | null;
}

/**
 * Deploy a host. Dispatches based on `mode`:
 *  - local_nginx: render nginx config + reload (unchanged).
 *  - cloudflare_tunnel: resolve tunnel.provider → provider.addHost() →
 *    write DNS record per edge endpoint kind → provider.reload().
 */
export async function deployHost(hostId: number): Promise<void> {
	const knex = getDb();
	const host = await knex<HostRow>('proxy_hosts').where({ id: hostId }).first();
	if (!host) throw new Error(`host ${hostId} not found`);

	if (host.mode === 'local_nginx') {
		await deployLocalNginx(hostId, host);
		return;
	}

	if (!host.tunnel_id) {
		throw new Error('cloudflare_tunnel mode requires tunnel_id');
	}

	const tunnelRow = await knex<TunnelRow>('tunnels').where({ id: host.tunnel_id }).first();
	if (!tunnelRow) throw new Error('tunnel not found');

	const providerName = (tunnelRow.provider ?? 'cloudflared') as TunnelProviderName;
	const provider = getProvider(providerName);
	const protocol = (host.protocol ?? 'http') as HostProtocol;

	if (!provider.supports.includes(protocol)) {
		throw new Error(
			`Provider '${providerName}' does not support protocol '${protocol}'. Pick a different tunnel or change host protocol.`
		);
	}

	const binding: HostBinding = {
		id: host.id,
		hostname: host.hostname,
		protocol,
		forward_host: host.forward_host,
		forward_port: host.forward_port,
		forward_scheme: host.forward_scheme as 'http' | 'https',
		path_prefix: host.path_prefix,
		tls: parseTls(host.tls_options),
	};

	try {
		const edge = await provider.addHost(tunnelRow.id, binding);
		await writeDnsForEdge(host, edge);

		await knex('proxy_hosts')
			.where({ id: hostId })
			.update({
				edge_endpoint: JSON.stringify(edge),
				last_deployed_at: new Date().toISOString(),
				last_error: null,
			});

		await provider.reload(tunnelRow.id);

		publish('host.deployed', { id: hostId, hostname: host.hostname });
		log.info(
			{ id: hostId, hostname: host.hostname, provider: providerName, edge: edge.kind },
			'Host deployed'
		);

		// Background diagnostics — only meaningful for HTTP hosts going through cloudflared.
		if (providerName === 'cloudflared' && (protocol === 'http' || protocol === 'https')) {
			const cnameTarget = `${tunnelRow.tunnel_id}.cfargotunnel.com`;
			void verifyDnsAndProbe(hostId, host, cnameTarget).catch((err) =>
				log.warn({ err: (err as Error).message, hostId }, 'post-deploy diagnostics crashed')
			);
		}
	} catch (err) {
		const msg = err instanceof CloudflareApiError ? err.message : (err as Error).message;
		await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
		publish('host.deploy_failed', { id: hostId, hostname: host.hostname, error: msg });
		throw err;
	}
}

// ---------------------------------------------------------------------------
// DNS record write — switches on edge.kind
// ---------------------------------------------------------------------------
async function writeDnsForEdge(host: HostRow, edge: ProviderEdgeEndpoint): Promise<void> {
	// host_port doesn't get a DNS record — the user has to give players the
	// raw host:port (e.g. Bedrock Minecraft). Persist edge_endpoint so the
	// UI can show it; skip DNS.
	if (edge.kind === 'host_port') {
		return;
	}

	if (!host.cf_zone_id) {
		throw new Error(
			`host has no cf_zone_id but provider returned a DNS-bound edge endpoint (${edge.kind}). Attach a zone to publish the record on, or switch to host_port mode.`
		);
	}

	const { token, zone_id } = await loadZoneToken(host.cf_zone_id);

	if (edge.kind === 'cname') {
		try {
			const recordId = await upsertCnameRecord(token, {
				zone_id,
				hostname: host.hostname,
				target: edge.target,
				existingRecordId: host.dns_record_id,
			});
			await persistDnsRecordId(host.id, recordId);
		} catch (cfErr) {
			throw translateDnsError(cfErr, host.hostname, zone_id);
		}
		return;
	}

	if (edge.kind === 'srv') {
		try {
			const recordId = await upsertSrvRecord(token, {
				zone_id,
				hostname: host.hostname,
				service: edge.service,
				proto: edge.proto,
				port: edge.port,
				target: edge.target,
				existingRecordId: host.dns_record_id,
			});
			await persistDnsRecordId(host.id, recordId);
		} catch (cfErr) {
			throw translateDnsError(cfErr, host.hostname, zone_id);
		}
		return;
	}
}

async function loadZoneToken(cfZoneId: number): Promise<{ token: string; zone_id: string }> {
	const knex = getDb();
	const zoneRow = await knex<{ zone_id: string; cloudflare_account_id: number }>('cf_zones')
		.where({ id: cfZoneId })
		.first();
	if (!zoneRow) throw new Error('zone not found');

	const accountRow = await knex<{ id: number; encrypted_credentials: Buffer | string; auth_type: string }>(
		'cloudflare_accounts'
	)
		.where({ id: zoneRow.cloudflare_account_id })
		.first();
	if (!accountRow) throw new Error('cf account not found for zone');

	const creds = decryptCredentials(accountRow);
	if (creds.type !== 'api_token') {
		throw new Error('OAuth zone credentials unsupported in this release');
	}
	return { token: creds.token, zone_id: zoneRow.zone_id };
}

async function persistDnsRecordId(hostId: number, recordId: string): Promise<void> {
	const knex = getDb();
	await knex('proxy_hosts').where({ id: hostId }).update({ dns_record_id: recordId });
}

function parseTls(raw: string | null | undefined): { no_tls_verify?: boolean } {
	if (!raw) return {};
	try {
		return typeof raw === 'string' ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// local_nginx (unchanged)
// ---------------------------------------------------------------------------
async function deployLocalNginx(hostId: number, host: HostRow): Promise<void> {
	const knex = getDb();
	const tls = parseTls(host.tls_options);
	try {
		await writeHostConfig({
			id: host.id,
			hostname: host.hostname,
			forward_scheme: host.forward_scheme,
			forward_host: host.forward_host,
			forward_port: host.forward_port,
			path_prefix: host.path_prefix,
			no_tls_verify: Boolean(tls.no_tls_verify),
		});
		await knex('proxy_hosts')
			.where({ id: hostId })
			.update({ last_deployed_at: new Date().toISOString(), last_error: null });
		publish('host.deployed', { id: hostId, mode: 'local_nginx', hostname: host.hostname });
		log.info({ id: hostId, hostname: host.hostname }, 'local_nginx host deployed');
	} catch (err) {
		const msg = (err as Error).message;
		await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
		publish('host.deploy_failed', { id: hostId, error: msg });
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Post-deploy diagnostics (cloudflared HTTP only)
// ---------------------------------------------------------------------------

async function verifyDnsAndProbe(hostId: number, host: HostRow, expectedCnameTarget: string): Promise<void> {
	const knex = getDb();
	const dnsResult = await verifyDns(host.hostname, expectedCnameTarget, { attempts: 6, intervalMs: 2000 });
	log.info({ hostId, hostname: host.hostname, dns: dnsResult.kind }, 'DNS verification done');

	if (dnsResult.kind !== 'ok') {
		const msg = formatDnsWarning(dnsResult, host.hostname, expectedCnameTarget);
		await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
		publish('host.deploy_failed', { id: hostId, hostname: host.hostname, error: msg });
		return;
	}

	await probeAndDiagnose(hostId, host);
}

function formatDnsWarning(
	result: { kind: string; message?: string; expected?: string; got?: string },
	hostname: string,
	expectedSuffix: string
): string {
	switch (result.kind) {
		case 'nxdomain':
			return `⚠ DNS: Cloudflare's resolver (1.1.1.1) returned NXDOMAIN for ${hostname}. The CNAME was NOT created — check the host's status and re-deploy.`;
		case 'no_record':
			return `⚠ DNS: No CNAME for ${hostname} after 12s of polling. Either the create call silently dropped, or your zone's nameservers haven't picked up the new record yet (rare — usually <60s). Retry "Re-deploy".`;
		case 'wrong_target':
			return `⚠ DNS: ${hostname} resolves to "${result.got}" but should point to "${expectedSuffix}". Another DNS record (probably from before) is taking precedence — delete it in your Cloudflare dashboard.`;
		case 'timeout':
			return `⚠ DNS: CloudGate couldn't reach 1.1.1.1 to verify ${hostname}. Outbound DNS-over-HTTPS may be blocked. The record might still work — open the host's URL to test.`;
		default:
			return `⚠ DNS verification failed: ${result.message ?? 'unknown'}`;
	}
}

async function probeAndDiagnose(hostId: number, host: HostRow): Promise<void> {
	const knex = getDb();
	const tlsOpts = parseTls(host.tls_options);
	const outcome = await probeUpstream({
		scheme: host.forward_scheme as 'http' | 'https',
		host: host.forward_host,
		port: host.forward_port,
		no_tls_verify: tlsOpts.no_tls_verify,
	});

	log.info({ hostId, hostname: host.hostname, outcome: outcome.kind }, 'upstream probe done');

	if (outcome.kind === 'ok') return;

	let label: string;
	switch (outcome.kind) {
		case 'tls_on_http_port':
			label = '⚠ Wrong scheme';
			break;
		case 'http_on_tls_port':
			label = '⚠ Wrong scheme';
			break;
		case 'tcp_refused':
			label = '⚠ Upstream unreachable';
			break;
		case 'tcp_timeout':
			label = '⚠ Upstream timed out';
			break;
		case 'self_signed_tls':
			label = '⚠ Self-signed TLS';
			break;
		case 'http_error':
			label = `⚠ Upstream returned ${outcome.statusCode}`;
			break;
		default:
			label = '⚠ Upstream probe inconclusive';
	}
	const msg = `${label}: ${outcome.message}`;
	await knex('proxy_hosts').where({ id: hostId }).update({ last_error: msg });
	publish('host.deploy_failed', { id: hostId, hostname: host.hostname, error: msg });
}

function translateDnsError(cfErr: unknown, hostname: string, zoneId: string): CloudflareApiError {
	const e = cfErr as {
		status?: number;
		statusCode?: number;
		message?: string;
		errors?: Array<{ code?: number | string; message?: string }>;
	};
	const status = e.status ?? e.statusCode ?? 500;
	const first = e.errors?.[0];
	const code = first?.code !== undefined ? Number(first.code) : null;
	const cfMsg = first?.message ?? '';

	if (code === 10000) {
		return new CloudflareApiError(
			403,
			'CF_DNS_PERMISSION',
			`Cloudflare rejected the DNS record write for ${hostname}. Token is missing the "Zone → DNS → Edit" permission on zone ${zoneId}, OR the token's "Zone Resources" scope excludes this zone. Fix it at dash.cloudflare.com/profile/api-tokens, then click Re-deploy.`,
			10000
		);
	}
	if (code === 81057) {
		return new CloudflareApiError(
			409,
			'CF_RECORD_ALREADY_EXISTS',
			`A DNS record for ${hostname} already exists in Cloudflare. Delete the conflicting record from your CF dashboard, then click Re-deploy.`,
			81057
		);
	}
	if (status === 403 || status === 401) {
		return new CloudflareApiError(
			status,
			'CF_AUTH_FAILED',
			`Cloudflare rejected the DNS request: ${cfMsg || e.message || 'auth failed'}. Verify the API token in Settings → Cloudflare.`,
			code
		);
	}
	return new CloudflareApiError(
		status,
		'CF_DNS_ERROR',
		`DNS record write failed for ${hostname}: ${cfMsg || e.message || 'unknown error'}`,
		code
	);
}

// ---------------------------------------------------------------------------
// Undeploy
// ---------------------------------------------------------------------------
export async function undeployHost(hostId: number): Promise<void> {
	const knex = getDb();
	const host = await knex<HostRow>('proxy_hosts').where({ id: hostId }).first();
	if (!host) return;

	// 1. Delete DNS record if we owned one.
	if (host.dns_record_id && host.cf_zone_id) {
		try {
			const { token, zone_id } = await loadZoneToken(host.cf_zone_id);
			await deleteDnsRecord(token, zone_id, host.dns_record_id);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'DNS record delete failed (continuing)');
		}
	}

	// 2. Tell the provider to drop the host.
	if (host.mode === 'cloudflare_tunnel' && host.tunnel_id) {
		const tunnelRow = await knex<TunnelRow>('tunnels').where({ id: host.tunnel_id }).first();
		if (tunnelRow) {
			const providerName = (tunnelRow.provider ?? 'cloudflared') as TunnelProviderName;
			try {
				await getProvider(providerName).removeHost(tunnelRow.id, hostId);
			} catch (err) {
				log.warn({ err: (err as Error).message }, 'provider.removeHost failed (continuing)');
			}
			try {
				await getProvider(providerName).reload(tunnelRow.id);
			} catch (err) {
				log.warn({ err: (err as Error).message }, 'tunnel reload during undeploy failed');
			}
		}
	}

	// 3. local_nginx — remove the config file.
	if (host.mode === 'local_nginx') {
		try {
			await removeHostConfig(host.id);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'local_nginx undeploy failed');
		}
	}
}
