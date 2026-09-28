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

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-bootstrap-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL = 'unit@test.local';
	// This suite exercises the headless/automated-install path (see
	// bootstrap.ts `seedAdminIfMissing`): setting the password env var is
	// what makes bootstrap create an admin at all on a fresh DB. The
	// interactive path (no env var -> no user, web UI Setup page creates
	// one) is covered separately in bootstrap-setup-mode.test.ts.
	process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD = 'unit-test-initial-pw-123456';
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL;
	delete process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD;
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

	// CHANGED: previously asserted initial-admin.txt WAS written. Since
	// CLOUDGATE_INITIAL_ADMIN_PASSWORD is now what triggers this seed path
	// (headless/automated install), the operator already knows the password
	// they set — bootstrap.ts no longer writes it back out to a file. See
	// bootstrap-setup-mode.test.ts for the interactive (no env var) path.
	it('does NOT write initial-admin.txt for a headless install (operator already knows the password)', () => {
		expect(existsSync(join(tmpDir, 'secrets', 'initial-admin.txt'))).toBe(false);
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
