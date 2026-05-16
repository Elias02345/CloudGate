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
