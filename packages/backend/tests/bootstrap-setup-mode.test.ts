/**
 * Bootstrap's `seedAdminIfMissing` step, interactive-install path: with no
 * CLOUDGATE_INITIAL_ADMIN_PASSWORD set, a fresh /data must end up with zero
 * users and no /data/secrets/initial-admin.txt — the web UI's Setup page
 * (POST /api/setup, see routes/setup.ts) is what creates the admin now.
 *
 * The headless path (env var set) is covered in bootstrap.test.ts.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-bootstrap-nosetup-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	delete process.env.CLOUDGATE_INITIAL_ADMIN_EMAIL;
	delete process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrap — interactive install (no CLOUDGATE_INITIAL_ADMIN_PASSWORD)', () => {
	it('creates zero users', async () => {
		const { getDb } = await import('../src/db/db.js');
		const row = await getDb()('users').count<{ c: number }[]>({ c: '*' }).first();
		expect(Number(row?.c)).toBe(0);
	});

	it('does not write /data/secrets/initial-admin.txt', () => {
		expect(existsSync(join(tmpDir, 'secrets', 'initial-admin.txt'))).toBe(false);
	});

	it('still completes bootstrap (secrets + migrations run regardless)', () => {
		expect(existsSync(join(tmpDir, 'secrets', 'encryption.key'))).toBe(true);
		expect(existsSync(join(tmpDir, 'secrets', 'jwt.key'))).toBe(true);
		expect(existsSync(join(tmpDir, '.bootstrap-complete'))).toBe(true);
	});
});
