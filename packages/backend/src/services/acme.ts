/**
 * ACME / Let's Encrypt cert acquisition for local_nginx hosts.
 *
 * Uses DNS-01 challenge via the user's Cloudflare account — perfect because
 * we already have CF API access for Tunnel/DNS management. DNS-01 also works
 * for hostnames behind CGNAT without needing port 80 reachable.
 *
 * Flow:
 *   1. Generate/load account key + cert key (per-host)
 *   2. Order cert from Let's Encrypt for the hostname
 *   3. Receive DNS-01 challenge token
 *   4. Create `_acme-challenge.<hostname>` TXT record via Cloudflare API
 *   5. Wait for propagation (~30s)
 *   6. Tell LE to verify, get the cert
 *   7. Delete the TXT record
 *   8. Save cert + key to /data/nginx/certs/<hostname>/{cert.pem,key.pem}
 *
 * Auto-renewal: cron checks every 24h, renews any cert with <30 days left.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as acme from 'acme-client';
import { dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptCredentials } from './cf-account.js';
import { clientFor } from './cloudflare-client.js';

const log = childLogger('acme');

// ---------------------------------------------------------------------------
// Account key — one per CloudGate instance, reused across all hosts.
// ---------------------------------------------------------------------------

async function loadOrCreateAccountKey(): Promise<Buffer> {
	const path = dataPath('secrets', 'acme-account.key');
	if (existsSync(path)) {
		return readFile(path);
	}
	log.info('Generating new ACME account key');
	const key = await acme.crypto.createPrivateKey();
	await mkdir(dataPath('secrets'), { recursive: true });
	await writeFile(path, key, { mode: 0o600 });
	return key;
}

// ---------------------------------------------------------------------------
// CF zone resolution — given a hostname, find which zone+account owns it
// ---------------------------------------------------------------------------

interface ZoneContext {
	zoneId: string;
	apiToken: string;
}

async function findZoneForHostname(hostname: string): Promise<ZoneContext | null> {
	const knex = getDb();
	// Pick zone where name is a suffix of hostname
	const zones = await knex<{
		id: number;
		zone_id: string;
		name: string;
		cloudflare_account_id: number;
	}>('cf_zones').select('id', 'zone_id', 'name', 'cloudflare_account_id');
	const match = zones.find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`));
	if (!match) return null;
	const account = await knex<{ encrypted_credentials: Buffer | string }>('cloudflare_accounts')
		.where({ id: match.cloudflare_account_id })
		.first();
	if (!account) return null;
	const creds = decryptCredentials(account);
	if (creds.type !== 'api_token') return null;
	return { zoneId: match.zone_id, apiToken: creds.token };
}

// ---------------------------------------------------------------------------
// DNS-01 challenge handlers (called by acme-client)
// ---------------------------------------------------------------------------

async function dnsCreateChallenge(
	hostname: string,
	keyAuthorization: string,
	zone: ZoneContext
): Promise<string> {
	const cf = clientFor(zone.apiToken);
	const recordName = `_acme-challenge.${hostname}`;
	log.info({ recordName }, 'Creating DNS-01 TXT record');
	// biome-ignore lint/suspicious/noExplicitAny: CF SDK types are loose
	const created = (await (cf.dns.records as any).create({
		zone_id: zone.zoneId,
		type: 'TXT',
		name: recordName,
		content: keyAuthorization,
		ttl: 60,
	})) as { id: string };
	return created.id;
}

async function dnsRemoveChallenge(recordId: string, zone: ZoneContext): Promise<void> {
	const cf = clientFor(zone.apiToken);
	try {
		// biome-ignore lint/suspicious/noExplicitAny: CF SDK types
		await (cf.dns.records as any).delete(recordId, { zone_id: zone.zoneId });
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'TXT record cleanup failed');
	}
}

async function waitForDnsPropagation(seconds: number): Promise<void> {
	log.info({ seconds }, 'Waiting for DNS propagation');
	await new Promise((r) => setTimeout(r, seconds * 1000));
}

// ---------------------------------------------------------------------------
// Public: acquire / renew cert for a hostname
// ---------------------------------------------------------------------------

export interface CertResult {
	cert_path: string;
	key_path: string;
	expires_at: string;
}

export async function acquireCert(
	hostname: string,
	options: { staging?: boolean; email?: string } = {}
): Promise<CertResult> {
	const zone = await findZoneForHostname(hostname);
	if (!zone) {
		throw new Error(
			`No Cloudflare zone found in CloudGate that owns ${hostname}. Add the zone via Cloudflare → Sync Zones first.`
		);
	}

	const accountKey = await loadOrCreateAccountKey();
	const client = new acme.Client({
		directoryUrl: options.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
		accountKey,
	});

	const [certKey, csr] = await acme.crypto.createCsr({
		commonName: hostname,
		altNames: [hostname],
	});

	log.info({ hostname, staging: !!options.staging }, 'Starting ACME order');
	let challengeRecordId: string | null = null;
	const cert = await client.auto({
		csr,
		email: options.email ?? 'cert@cloudgate.local',
		termsOfServiceAgreed: true,
		challengePriority: ['dns-01'],
		challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
			if (challenge.type !== 'dns-01') return;
			challengeRecordId = await dnsCreateChallenge(hostname, keyAuthorization, zone);
			await waitForDnsPropagation(30);
		},
		challengeRemoveFn: async () => {
			if (challengeRecordId) {
				await dnsRemoveChallenge(challengeRecordId, zone);
				challengeRecordId = null;
			}
		},
	});

	// Persist
	const certDir = dataPath('nginx', 'certs', hostname);
	await mkdir(certDir, { recursive: true });
	const certPath = `${certDir}/cert.pem`;
	const keyPath = `${certDir}/key.pem`;
	await writeFile(certPath, cert, { encoding: 'utf8', mode: 0o644 });
	await writeFile(keyPath, certKey, { encoding: 'utf8', mode: 0o600 });

	// Parse expiry from cert PEM
	const expiresAt = parseCertExpiry(cert.toString()) ?? new Date(Date.now() + 90 * 86400 * 1000).toISOString();

	log.info({ hostname, certPath, expiresAt }, 'Cert acquired');
	return { cert_path: certPath, key_path: keyPath, expires_at: expiresAt };
}

function parseCertExpiry(pem: string): string | null {
	// Use Node's X509Certificate (built-in since Node 18)
	try {
		const { X509Certificate } = require('node:crypto') as typeof import('node:crypto');
		const c = new X509Certificate(pem);
		return new Date(c.validTo).toISOString();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Renewal cron — invoked from updater init or a separate timer
// ---------------------------------------------------------------------------

const RENEWAL_THRESHOLD_DAYS = 30;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let renewalTimer: NodeJS.Timeout | null = null;

async function checkAllCerts(): Promise<void> {
	const knex = getDb();
	const hosts = await knex<{ id: number; hostname: string; meta: string }>('proxy_hosts')
		.where({ mode: 'local_nginx' })
		.select('id', 'hostname', 'meta');

	for (const host of hosts) {
		let meta: Record<string, unknown> = {};
		try {
			meta = typeof host.meta === 'string' ? JSON.parse(host.meta) : {};
		} catch {
			meta = {};
		}
		const expires = typeof meta.cert_expires_at === 'string' ? meta.cert_expires_at : null;
		if (!expires) continue;
		const daysLeft = (new Date(expires).getTime() - Date.now()) / 86400_000;
		if (daysLeft > RENEWAL_THRESHOLD_DAYS) continue;
		log.info({ hostname: host.hostname, daysLeft }, 'Cert nearing expiry — renewing');
		try {
			const result = await acquireCert(host.hostname);
			meta.cert_path = result.cert_path;
			meta.cert_key_path = result.key_path;
			meta.cert_expires_at = result.expires_at;
			await knex('proxy_hosts').where({ id: host.id }).update({
				meta: JSON.stringify(meta),
				updated_at: new Date().toISOString(),
			});
		} catch (err) {
			log.warn({ hostname: host.hostname, err: (err as Error).message }, 'Renewal failed');
		}
	}
}

export function initRenewalCron(): void {
	if (renewalTimer) return;
	// First check 5 min after boot, then every 24h
	setTimeout(() => void checkAllCerts(), 5 * 60 * 1000).unref();
	renewalTimer = setInterval(() => void checkAllCerts(), CHECK_INTERVAL_MS);
	renewalTimer.unref?.();
	log.info('ACME renewal cron initialised');
}
