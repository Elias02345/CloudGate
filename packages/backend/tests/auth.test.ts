/**
 * End-to-end auth service tests.
 *
 * Spins up an in-memory-ish SQLite (file in a temp dir, since better-sqlite3
 * needs a real file path with WAL). Runs bootstrap to seed admin + secrets.
 * Then exercises login, JWT verify, password change.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-auth-test-'));
	mkdirSync(join(tmpDir, 'db'), { recursive: true });
	mkdirSync(join(tmpDir, 'secrets'), { recursive: true });
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL = 'test-admin@cloudgate.test';
	process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD = 'initial-test-pw-123456';

	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) {
		throw new Error(`bootstrap failed in test setup: ${status.last_error}`);
	}
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('auth service', () => {
	it('seeds an initial admin user', async () => {
		const { findUserByEmail } = await import('../src/services/auth.js');
		const u = await findUserByEmail('test-admin@cloudgate.test');
		expect(u).not.toBeNull();
		expect(u?.email).toBe('test-admin@cloudgate.test');
		expect(u?.is_admin).toBe(1);
		expect(u?.must_change_password).toBe(1);
	});

	it('verifies the seeded password', async () => {
		const { findUserByEmail, verifyPassword } = await import('../src/services/auth.js');
		const u = await findUserByEmail('test-admin@cloudgate.test');
		expect(u).not.toBeNull();
		const ok = await verifyPassword(u!.password_hash, 'initial-test-pw-123456');
		expect(ok).toBe(true);
		const bad = await verifyPassword(u!.password_hash, 'wrong-password');
		expect(bad).toBe(false);
	});

	it('issues + verifies a JWT', async () => {
		const { issueAccessToken, verifyAccessToken } = await import('../src/services/auth.js');
		const token = await issueAccessToken({
			sub: '1',
			email: 'test-admin@cloudgate.test',
			is_admin: true,
		});
		expect(token.split('.')).toHaveLength(3); // JWS structure
		const claims = await verifyAccessToken(token);
		expect(claims.sub).toBe('1');
		expect(claims.email).toBe('test-admin@cloudgate.test');
		expect(claims.is_admin).toBe(true);
	});

	it('rejects a tampered JWT', async () => {
		const { issueAccessToken, verifyAccessToken } = await import('../src/services/auth.js');
		const token = await issueAccessToken({ sub: '1', email: 'x', is_admin: false });
		const tampered = `${token.slice(0, -3)}XXX`;
		await expect(verifyAccessToken(tampered)).rejects.toThrow();
	});

	it('changePassword updates hash + clears must_change_password', async () => {
		const { findUserByEmail, changePassword, verifyPassword } = await import('../src/services/auth.js');
		const before = await findUserByEmail('test-admin@cloudgate.test');
		expect(before!.must_change_password).toBe(1);
		await changePassword(before!.id, 'new-secure-pw-987654');
		const after = await findUserByEmail('test-admin@cloudgate.test');
		expect(after!.must_change_password).toBe(0);
		expect(await verifyPassword(after!.password_hash, 'new-secure-pw-987654')).toBe(true);
		expect(await verifyPassword(after!.password_hash, 'initial-test-pw-123456')).toBe(false);
	});
});

describe('encryption key roundtrip check', () => {
	it('seeds encryption_key_check on first run, verifies on subsequent', async () => {
		const { verifyKeyOrSeed } = await import('../src/services/crypto.js');
		// Bootstrap already ran in beforeAll, but verifyKeyOrSeed wasn't called.
		// First call seeds. Second call should pass.
		const first = await verifyKeyOrSeed();
		expect(first.ok).toBe(true);
		const second = await verifyKeyOrSeed();
		expect(second.ok).toBe(true);
	});
});
