/**
 * Token-encryption service.
 *
 * Wraps AES-256-GCM with the key from `/data/secrets/encryption.key`.
 * The key is materialized during bootstrap (see bootstrap.ts) — this module
 * trusts it exists.
 *
 * Wire format (single string, base64-url):
 *   nonce(12 bytes) | ciphertext | authtag(16 bytes)
 *
 * The wire format is self-contained — no separate IV/tag fields in the DB.
 * Reading just needs the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';

const log = childLogger('crypto');

const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
	if (cachedKey) return cachedKey;
	const raw = readFileSync(dataPath('secrets', 'encryption.key'), 'utf8').trim();
	const key = Buffer.from(raw, 'base64');
	if (key.length !== KEY_LENGTH) {
		throw new Error(
			`Invalid encryption key length: expected ${KEY_LENGTH} bytes, got ${key.length}. ` +
				`The key file at /data/secrets/encryption.key is corrupted.`
		);
	}
	cachedKey = key;
	return key;
}

export function encrypt(plaintext: string | Buffer): string {
	const key = loadKey();
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, nonce);
	const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
	const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return Buffer.concat([nonce, encrypted, authTag]).toString('base64url');
}

export function decrypt(payload: string): string {
	const key = loadKey();
	const data = Buffer.from(payload, 'base64url');
	if (data.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error('Ciphertext too short — possibly corrupted');
	}
	const nonce = data.subarray(0, NONCE_LENGTH);
	const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
	const ciphertext = data.subarray(NONCE_LENGTH, data.length - AUTH_TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, key, nonce);
	decipher.setAuthTag(authTag);
	const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return decrypted.toString('utf8');
}

/**
 * Encrypts JSON-serialisable data. Convenience helper used by the
 * Cloudflare-account storage layer.
 */
export function encryptJson<T>(value: T): string {
	return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
	return JSON.parse(decrypt(payload)) as T;
}

/**
 * Performs a roundtrip check stored in `settings.encryption_key_check`.
 * Returns true if the key matches what was used to seed the check value;
 * returns false if mismatch — backend should refuse to start in that case.
 *
 * On first run (no check value stored), seeds a new one and returns true.
 */
export async function verifyKeyOrSeed(): Promise<{ ok: boolean; reason?: string }> {
	const knex = getDb();
	const row = await knex<{ key: string; value: string }>('settings')
		.where({ key: 'encryption_key_check' })
		.first();

	if (!row) {
		// First time — seed with a known plaintext encrypted under the current key.
		const seed = encrypt('cloudgate-key-check-v1');
		await knex('settings').insert({
			key: 'encryption_key_check',
			value: JSON.stringify(seed),
			updated_at: new Date().toISOString(),
		});
		log.info('Seeded encryption_key_check');
		return { ok: true };
	}

	try {
		const stored = JSON.parse(row.value) as string;
		const plaintext = decrypt(stored);
		if (plaintext !== 'cloudgate-key-check-v1') {
			return { ok: false, reason: 'decryption succeeded but plaintext mismatch (unexpected)' };
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: `encryption key does not match the one used previously: ${(err as Error).message}`,
		};
	}
}
