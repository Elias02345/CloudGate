/**
 * Tests for services/crypto.ts.
 *
 * Verifies AES-256-GCM round-trip + tamper-detection. Uses a temp data dir
 * so the real /data/secrets/encryption.key isn't touched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-crypto-'));
	mkdirSync(join(tmpDir, 'secrets'), { recursive: true, mode: 0o700 });
	const key = randomBytes(32).toString('base64');
	writeFileSync(join(tmpDir, 'secrets', 'encryption.key'), key, { encoding: 'utf8', mode: 0o600 });
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	// Force config cache invalidation: re-require module after env is set.
});

afterAll(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('crypto', () => {
	it('encrypt → decrypt round-trips a string', async () => {
		// Late import so config picks up our tmpDir
		const { encrypt, decrypt } = await import('../src/services/crypto.js');
		const plaintext = 'hello-world-with-special-chars-äöü€🌩️';
		const cipher = encrypt(plaintext);
		expect(cipher).not.toContain(plaintext);
		expect(decrypt(cipher)).toBe(plaintext);
	});

	it('encryptJson/decryptJson round-trips an object', async () => {
		const { encryptJson, decryptJson } = await import('../src/services/crypto.js');
		const original = { token: 'cf-token-abc', scopes: ['Tunnels:Edit', 'DNS:Edit'], num: 42 };
		const cipher = encryptJson(original);
		expect(decryptJson<typeof original>(cipher)).toEqual(original);
	});

	it('tampered ciphertext throws (auth-tag fails)', async () => {
		const { encrypt, decrypt } = await import('../src/services/crypto.js');
		const cipher = encrypt('important');
		// Flip a byte in the middle of the payload
		const buf = Buffer.from(cipher, 'base64url');
		buf[20] = buf[20]! ^ 0xff;
		const tampered = buf.toString('base64url');
		expect(() => decrypt(tampered)).toThrow();
	});

	it('too-short payload throws cleanly', async () => {
		const { decrypt } = await import('../src/services/crypto.js');
		expect(() => decrypt('too-short')).toThrow(/too short|Invalid|corrupted/i);
	});
});
