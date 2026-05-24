/**
 * Bootstrap test suite (minimal stable subset).
 *
 * Per CLAUDE.md §6: this test must stay green.
 *
 * ESM module-cache in vitest/esbuild prevents us from re-importing the
 * bootstrap module per-test. We therefore exercise it once and verify the
 * contract via observable file outputs + DB state.
 *
 * Deeper idempotency tests (multi-run regen, re-seed-prevention) live in
 * `auth.test.ts` which already runs bootstrap in beforeAll and exercises
 * the same code paths.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-bootstrap-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL = 'unit@test.local';
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL;
});

describe('bootstrap', () => {
	it('generates encryption.key on fresh /data', () => {
		expect(existsSync(join(tmpDir, 'secrets', 'encryption.key'))).toBe(true);
		const key = readFileSync(join(tmpDir, 'secrets', 'encryption.key'), 'utf8').trim();
		// base64 of 32 bytes is 44 chars
		expect(key.length).toBeGreaterThanOrEqual(40);
	});

	it('generates jwt.key on fresh /data', () => {
		expect(existsSync(join(tmpDir, 'secrets', 'jwt.key'))).toBe(true);
	});

	it('writes initial-admin.txt with credentials', () => {
		const file = join(tmpDir, 'secrets', 'initial-admin.txt');
		expect(existsSync(file)).toBe(true);
		const contents = readFileSync(file, 'utf8');
		expect(contents).toContain('unit@test.local');
		expect(contents).toContain('Password:');
	});

	it('writes the bootstrap-complete marker', () => {
		expect(existsSync(join(tmpDir, '.bootstrap-complete'))).toBe(true);
	});

	it('writes /data/.version', () => {
		expect(existsSync(join(tmpDir, '.version'))).toBe(true);
	});

	it('creates DB and seeds exactly one admin user', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		const rows = await knex('users').count<{ c: number }[]>({ c: '*' }).first();
		expect(Number(rows?.c)).toBe(1);
	});

	it('migration 004 added playit_accounts table + new columns', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		expect(await knex.schema.hasTable('playit_accounts')).toBe(true);
		expect(await knex.schema.hasColumn('tunnels', 'provider')).toBe(true);
		expect(await knex.schema.hasColumn('tunnels', 'provider_meta')).toBe(true);
		expect(await knex.schema.hasColumn('tunnels', 'playit_account_id')).toBe(true);
		expect(await knex.schema.hasColumn('proxy_hosts', 'protocol')).toBe(true);
		expect(await knex.schema.hasColumn('proxy_hosts', 'edge_endpoint')).toBe(true);
	});

	it('secrets dir has restrictive perms on POSIX', () => {
		if (process.platform === 'win32') return;
		const stat = statSync(join(tmpDir, 'secrets'));
		// eslint-disable-next-line no-bitwise
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o700);
	});
});
