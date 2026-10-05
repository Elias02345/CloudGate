/**
 * Playit account storage layer.
 *
 * The secret_key is stored encrypted via services/crypto.ts. Routes never
 * read encrypted_secret_key directly — use `decryptPlayitSecret` to
 * materialise the secret on demand.
 */

import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptJson, encryptJson } from './crypto.js';

const log = childLogger('playit-account');

export interface DbPlayitAccount {
	id: number;
	user_id: number;
	label: string;
	encrypted_secret_key: Buffer | string;
	status: 'active' | 'disabled' | 'error';
	last_validated_at: string | null;
	created_at: string;
}

/** Encrypted-value wrapper — matches the shape used for CF tokens. */
interface PlayitSecretEnvelope {
	type: 'playit';
	secret: string;
}

export function publicPlayitAccount(row: DbPlayitAccount): {
	id: number;
	label: string;
	status: DbPlayitAccount['status'];
	last_validated_at: string | null;
	created_at: string;
} {
	return {
		id: row.id,
		label: row.label,
		status: row.status,
		last_validated_at: row.last_validated_at,
		created_at: row.created_at,
	};
}

export async function listAccountsForUser(userId: number): Promise<DbPlayitAccount[]> {
	const knex = getDb();
	return knex<DbPlayitAccount>('playit_accounts').where({ user_id: userId }).orderBy('id');
}

export async function getAccountById(id: number, userId: number): Promise<DbPlayitAccount | null> {
	const knex = getDb();
	const row = await knex<DbPlayitAccount>('playit_accounts').where({ id, user_id: userId }).first();
	return row ?? null;
}

export async function createAccount(input: {
	user_id: number;
	label: string;
	secret_key: string;
}): Promise<DbPlayitAccount> {
	const knex = getDb();
	const envelope: PlayitSecretEnvelope = { type: 'playit', secret: input.secret_key };
	const encrypted = encryptJson(envelope);
	const now = new Date().toISOString();
	const [id] = await knex('playit_accounts').insert({
		user_id: input.user_id,
		label: input.label,
		encrypted_secret_key: encrypted,
		status: 'active',
		last_validated_at: now,
		created_at: now,
	});
	const row = await knex<DbPlayitAccount>('playit_accounts').where({ id }).first();
	if (!row) throw new Error('Failed to read back inserted Playit account');
	log.info({ id, label: input.label }, 'Created Playit account');
	return row;
}

export async function deleteAccount(id: number, userId: number): Promise<boolean> {
	const knex = getDb();
	const n = await knex('playit_accounts').where({ id, user_id: userId }).delete();
	log.info({ id, n }, 'Deleted Playit account');
	return n > 0;
}

export async function touchValidated(id: number): Promise<void> {
	const knex = getDb();
	await knex('playit_accounts').where({ id }).update({ last_validated_at: new Date().toISOString() });
}

/** Decrypt the stored secret. Throws if encryption key has changed. */
export function decryptPlayitSecret(row: { encrypted_secret_key: Buffer | string }): string {
	const raw =
		typeof row.encrypted_secret_key === 'string'
			? row.encrypted_secret_key
			: row.encrypted_secret_key.toString('utf8');
	const envelope = decryptJson<PlayitSecretEnvelope>(raw);
	return envelope.secret;
}

/**
 * Every linked account gets one playit tunnel row, created right away.
 * The agent only runs for tunnel rows, and the host form only offers
 * tunnel rows, so an account without one sat "offline" on playit.gg and
 * could not be picked for a host. Returns the row id (existing or new);
 * starting the agent is the caller's job.
 */
export async function ensurePlayitTunnelRow(accountId: number, label: string): Promise<number> {
	const knex = getDb();
	const existing = await knex<{ id: number }>('tunnels')
		.where({ provider: 'playit', playit_account_id: accountId })
		.first('id');
	if (existing) return existing.id;
	const now = new Date().toISOString();
	const [id] = await knex('tunnels').insert({
		cloudflare_account_id: null,
		playit_account_id: accountId,
		provider: 'playit',
		provider_meta: JSON.stringify({ playit_account_id: accountId, hosts: {} }),
		// Synthetic: playit has no tunnel object at this level; per-host
		// tunnels are created by PlayitProvider.addHost().
		tunnel_id: `playit-${accountId}-${Date.now().toString(36)}`,
		name: `playit-${label.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60) || accountId}`,
		account_tag: null,
		encrypted_tunnel_secret: null,
		credentials_path: null,
		status: 'starting',
		last_status_at: now,
		created_at: now,
	});
	log.info({ accountId, tunnelId: id }, 'Created playit tunnel row for account');
	return Number(id);
}
