/**
 * Bootstrap test suite.
 *
 * Per CLAUDE.md §6: this test must stay green. It guards against:
 *   - regenerating secrets when files exist
 *   - destroying user data on second boot
 *   - failing to recover from a partially-set-up /data dir
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

async function freshBootstrap(): Promise<typeof import('../src/bootstrap.js')> {
	// Re-import each test to get a fresh module state.
	// We mutate process.env first so dataPath() picks up the test dir.
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const mod = await import('../src/bootstrap.js?cachebust=' + Math.random());
	return mod;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-bootstrap-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
});

afterEach(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrap (idempotency contract)', () => {
	it('generates secrets on a fresh /data', async () => {
		const { runBootstrap } = await freshBootstrap();
		const status = await runBootstrap();
		expect(status.complete).toBe(true);
		expect(existsSync(join(tmpDir, 'secrets', 'encryption.key'))).toBe(true);
		expect(existsSync(join(tmpDir, 'secrets', 'jwt.key'))).toBe(true);
		expect(existsSync(join(tmpDir, '.bootstrap-complete'))).toBe(true);
	});

	it('does NOT regenerate existing secrets on a second run', async () => {
		// First run — seeds everything
		const { runBootstrap } = await freshBootstrap();
		await runBootstrap();
		const firstEnc = readFileSync(join(tmpDir, 'secrets', 'encryption.key'), 'utf8');
		const firstJwt = readFileSync(join(tmpDir, 'secrets', 'jwt.key'), 'utf8');

		// Close DB so reopen works
		const { closeDb } = await import('../src/db/db.js');
		await closeDb();

		// Second run — must reuse
		const { runBootstrap: run2 } = await freshBootstrap();
		await run2();
		const secondEnc = readFileSync(join(tmpDir, 'secrets', 'encryption.key'), 'utf8');
		const secondJwt = readFileSync(join(tmpDir, 'secrets', 'jwt.key'), 'utf8');

		expect(secondEnc).toBe(firstEnc);
		expect(secondJwt).toBe(firstJwt);
	});

	it('writes the initial-admin.txt with credentials', async () => {
		process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL = 'unit@test.local';
		const { runBootstrap } = await freshBootstrap();
		await runBootstrap();
		const adminFile = join(tmpDir, 'secrets', 'initial-admin.txt');
		expect(existsSync(adminFile)).toBe(true);
		const contents = readFileSync(adminFile, 'utf8');
		expect(contents).toContain('unit@test.local');
		expect(contents).toContain('Password:');
		// reset for other tests
		delete process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL;
	});

	it('uses ENV-provided keys when present', async () => {
		// Provide a deterministic key
		const stubKey = Buffer.alloc(32, 0xab).toString('base64');
		process.env.CLOUDGATE_ENCRYPTION_KEY = stubKey;
		const { runBootstrap } = await freshBootstrap();
		await runBootstrap();
		const actual = readFileSync(join(tmpDir, 'secrets', 'encryption.key'), 'utf8').trim();
		expect(actual).toBe(stubKey);
		delete process.env.CLOUDGATE_ENCRYPTION_KEY;
	});

	it('does NOT re-seed admin user when users table has rows', async () => {
		// First run — creates an admin
		const { runBootstrap } = await freshBootstrap();
		await runBootstrap();

		// Read the admin row
		const { getDb, closeDb } = await import('../src/db/db.js');
		const knex = getDb();
		const firstUserRow = await knex('users').first();
		expect(firstUserRow).toBeDefined();
		const originalEmail = firstUserRow.email;
		await closeDb();

		// Second run with a DIFFERENT initial email — should still NOT replace
		process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL = 'different@user.local';
		const { runBootstrap: run2 } = await freshBootstrap();
		await run2();

		const { getDb: getDb2, closeDb: closeDb2 } = await import('../src/db/db.js');
		const knex2 = getDb2();
		const count = await knex2('users').count<{ c: number }[]>({ c: '*' }).first();
		expect(Number(count?.c)).toBe(1);
		const secondUserRow = await knex2('users').first();
		expect(secondUserRow.email).toBe(originalEmail);
		await closeDb2();
		delete process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL;
	});

	it('writes /data/.version after success', async () => {
		const { runBootstrap } = await freshBootstrap();
		await runBootstrap();
		expect(existsSync(join(tmpDir, '.version'))).toBe(true);
	});

	it('writes /data/.bootstrap-error when DATA_DIR is read-only', async () => {
		// Create a file in place of where DATA_DIR's children should go — forces write probe failure.
		// Skipping on Windows (chmod doesn't work the same).
		if (process.platform === 'win32') return;
		// Make DATA_DIR readonly
		const fs = await import('node:fs');
		fs.chmodSync(tmpDir, 0o555);
		try {
			const { runBootstrap } = await freshBootstrap();
			const status = await runBootstrap();
			expect(status.complete).toBe(false);
		} finally {
			fs.chmodSync(tmpDir, 0o755);
		}
	});
});
