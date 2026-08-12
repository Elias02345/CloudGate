/**
 * Cloudflare account storage layer.
 *
 * The actual token (or oauth cert) is stored encrypted via services/crypto.
 * Routes / business logic should NEVER read encrypted_credentials directly —
 * use `decryptToken(account)` to materialise the secret on demand.
 */

import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptJson, encryptJson } from './crypto.js';

const log = childLogger('cf-account');

export interface DbCfAccount {
	id: number;
	user_id: number;
	label: string;
	auth_type: 'api_token' | 'oauth';
	encrypted_credentials: Buffer | string;
	account_tag: string;
	email: string | null;
	last_validated_at: string | null;
	created_at: string;
}

interface ApiTokenCreds {
	type: 'api_token';
	token: string;
}

interface OAuthCreds {
	type: 'oauth';
	cert_pem: string;
}

export type Credentials = ApiTokenCreds | OAuthCreds;

export function publicAccount(row: DbCfAccount): {
	id: number;
	label: string;
	auth_type: 'api_token' | 'oauth';
	account_tag: string;
	email: string | null;
	last_validated_at: string | null;
	created_at: string;
} {
	return {
		id: row.id,
		label: row.label,
		auth_type: row.auth_type,
		account_tag: row.account_tag,
		email: row.email,
		last_validated_at: row.last_validated_at,
		created_at: row.created_at,
	};
}

export async function listAccountsForUser(userId: number): Promise<DbCfAccount[]> {
	const knex = getDb();
	return knex<DbCfAccount>('cloudflare_accounts').where({ user_id: userId }).orderBy('id');
}

export async function getAccountById(id: number, userId: number): Promise<DbCfAccount | null> {
	const knex = getDb();
	const row = await knex<DbCfAccount>('cloudflare_accounts').where({ id, user_id: userId }).first();
	return row ?? null;
}

export async function createAccount(input: {
	user_id: number;
	label: string;
	auth_type: 'api_token' | 'oauth';
	credentials: Credentials;
	account_tag: string;
	email?: string | null;
}): Promise<DbCfAccount> {
	const knex = getDb();
	const encrypted = encryptJson(input.credentials);
	const now = new Date().toISOString();
	const [id] = await knex('cloudflare_accounts').insert({
		user_id: input.user_id,
		label: input.label,
		auth_type: input.auth_type,
		encrypted_credentials: encrypted,
		account_tag: input.account_tag,
		email: input.email ?? null,
		last_validated_at: now,
		created_at: now,
	});
	const row = await knex<DbCfAccount>('cloudflare_accounts').where({ id }).first();
	if (!row) throw new Error('Failed to read back inserted CF account');
	log.info({ id, label: input.label }, 'Created CF account');
	return row;
}

export async function deleteAccount(id: number, userId: number): Promise<boolean> {
	const knex = getDb();
	const n = await knex('cloudflare_accounts').where({ id, user_id: userId }).delete();
	log.info({ id, n }, 'Deleted CF account');
	return n > 0;
}

export async function touchValidated(id: number): Promise<void> {
	const knex = getDb();
	await knex('cloudflare_accounts').where({ id }).update({ last_validated_at: new Date().toISOString() });
}

/**
 * Persist a freshly-fetched zone list for an account.
 *
 * CRITICAL: this UPSERTs on the (cloudflare_account_id, zone_id) unique key
 * so existing zone rows keep their primary-key `id`. proxy_hosts.cf_zone_id
 * references cf_zones.id with ON DELETE SET NULL — the previous delete-all +
 * re-insert reassigned every zone a fresh id and thereby NULLed the
 * cf_zone_id of every attached host on *every* sync. That is the root cause
 * of the recurring "orphaned hosts" (a host stuck without a zone can't
 * publish its DNS record). Zones Cloudflare no longer returns are pruned;
 * SET NULL on their hosts is correct there because the zone is genuinely gone.
 */
export async function syncZonesForAccount(
	accountId: number,
	zones: Array<{ id: string; name: string; status: string }>
): Promise<number> {
	const knex = getDb();
	const now = new Date().toISOString();
	await knex.transaction(async (trx) => {
		if (zones.length > 0) {
			await trx('cf_zones')
				.insert(
					zones.map((z) => ({
						cloudflare_account_id: accountId,
						zone_id: z.id,
						name: z.name,
						status: z.status,
						last_synced_at: now,
					}))
				)
				.onConflict(['cloudflare_account_id', 'zone_id'])
				.merge(['name', 'status', 'last_synced_at']);
		}
		// Prune only zones CF no longer returns — never touch the live ones,
		// otherwise attached hosts would be orphaned again.
		const liveZoneIds = zones.map((z) => z.id);
		const prune = trx('cf_zones').where({ cloudflare_account_id: accountId });
		if (liveZoneIds.length > 0) prune.whereNotIn('zone_id', liveZoneIds);
		await prune.delete();
	});
	return zones.length;
}

/**
 * Materialise the stored credentials for use by the API client.
 * Throws if encryption key has changed (decryption fails).
 */
export function decryptCredentials(row: { encrypted_credentials: Buffer | string }): Credentials {
	const raw =
		typeof row.encrypted_credentials === 'string'
			? row.encrypted_credentials
			: row.encrypted_credentials.toString('utf8');
	return decryptJson<Credentials>(raw);
}
