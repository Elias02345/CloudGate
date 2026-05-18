/**
 * API-key management for the Shell API.
 *
 * Key format: `cgk_<8charPrefix>_<32charSecret>` where:
 *   - prefix is plaintext (lookup index in DB)
 *   - secret is high-entropy base32-ish from crypto.randomBytes
 *   - DB stores: `prefix`, `key_hash = sha256(full_key)`, `scope`
 *
 * Full key is returned ONCE by createApiKey() — the caller (HTTP route) must
 * surface it to the user immediately and never again. Verifying a key in the
 * request middleware looks up by prefix, then sha256-compares against
 * key_hash with a constant-time check.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/db.js';

const PREFIX_LENGTH = 8;
const SECRET_LENGTH = 32;
const KEY_PREFIX = 'cgk';

export type ApiKeyScope = 'read' | 'admin';

export interface ApiKeyRow {
	id: number;
	user_id: number;
	name: string;
	prefix: string;
	scope: ApiKeyScope;
	last_used_at: string | null;
	last_used_ip: string | null;
	expires_at: string | null;
	created_at: string;
}

export interface CreateApiKeyResult {
	row: ApiKeyRow;
	/** The full key — show ONCE, never persisted in plaintext. */
	plaintext: string;
}

/** crypto-safe charset for the secret part (no ambiguous chars). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(length: number): string {
	const out: string[] = [];
	const bytes = randomBytes(length);
	for (let i = 0; i < length; i++) {
		const idx = bytes[i] ?? 0;
		out.push(ALPHABET[idx % ALPHABET.length] ?? 'a');
	}
	return out.join('');
}

function hashKey(fullKey: string): string {
	return createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

/** Generate a fresh key + its DB-storable hash + the lookup prefix. */
function generateKey(): { full: string; prefix: string; hash: string } {
	const prefixPart = randomString(PREFIX_LENGTH);
	const secretPart = randomString(SECRET_LENGTH);
	const prefix = `${KEY_PREFIX}_${prefixPart}`;
	const full = `${prefix}_${secretPart}`;
	return { full, prefix, hash: hashKey(full) };
}

export async function createApiKey(args: {
	user_id: number;
	name: string;
	scope: ApiKeyScope;
	expires_at?: string | null;
}): Promise<CreateApiKeyResult> {
	const knex = getDb();
	const { full, prefix, hash } = generateKey();
	const now = new Date().toISOString();
	const [id] = await knex('api_keys').insert({
		user_id: args.user_id,
		name: args.name,
		prefix,
		key_hash: hash,
		scope: args.scope,
		expires_at: args.expires_at ?? null,
		created_at: now,
	});
	const row = await knex<ApiKeyRow>('api_keys').where({ id }).first();
	if (!row) throw new Error('Failed to read back newly created api_key row');
	return { row, plaintext: full };
}

export async function listApiKeys(userId: number): Promise<ApiKeyRow[]> {
	const knex = getDb();
	return knex<ApiKeyRow>('api_keys').where({ user_id: userId }).orderBy('created_at', 'desc');
}

export async function revokeApiKey(userId: number, id: number): Promise<boolean> {
	const knex = getDb();
	const deleted = await knex('api_keys').where({ id, user_id: userId }).delete();
	return deleted > 0;
}

export async function rotateApiKey(userId: number, id: number): Promise<CreateApiKeyResult | null> {
	const knex = getDb();
	const existing = await knex<ApiKeyRow>('api_keys').where({ id, user_id: userId }).first();
	if (!existing) return null;
	const { full, prefix, hash } = generateKey();
	await knex('api_keys').where({ id }).update({
		prefix,
		key_hash: hash,
		last_used_at: null,
		last_used_ip: null,
	});
	const updated = await knex<ApiKeyRow>('api_keys').where({ id }).first();
	if (!updated) throw new Error('rotate: row vanished mid-update');
	return { row: updated, plaintext: full };
}

/**
 * Look up a key by its full plaintext. Returns the row + scope when the hash
 * matches; null when prefix unknown OR hash mismatched OR expired. Updates
 * last_used_at / last_used_ip async (non-blocking).
 */
export async function verifyApiKey(fullKey: string, ip: string | null): Promise<ApiKeyRow | null> {
	if (!fullKey.startsWith(`${KEY_PREFIX}_`)) return null;
	// Parse prefix from "cgk_xxxxxxxx_yyyy..."
	const parts = fullKey.split('_');
	if (parts.length < 3) return null;
	const prefix = `${parts[0]}_${parts[1]}`;
	const knex = getDb();
	const row = await knex<ApiKeyRow & { key_hash: string }>('api_keys').where({ prefix }).first();
	if (!row) return null;

	const candidateHash = hashKey(fullKey);
	const a = Buffer.from(candidateHash, 'hex');
	const b = Buffer.from(row.key_hash, 'hex');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

	// Fire-and-forget last_used update — don't block the request
	void knex('api_keys')
		.where({ id: row.id })
		.update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
		.catch(() => {
			/* ignore */
		});

	return row;
}
