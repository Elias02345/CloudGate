/**
 * Persistence-contract test (stable subset).
 *
 * Per CLAUDE.md §6: ensures sacred paths remain readable + have correct
 * permissions after bootstrap.
 *
 * Multi-run / mutation tests would require module-cache invalidation
 * which ESM+esbuild doesn't support cleanly. The deeper assertions move
 * into M5 update integration tests where they're naturally exercised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-persist-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('persistence contract — file outputs', () => {
	const sacredFiles = [
		['secrets', 'encryption.key'],
		['secrets', 'jwt.key'],
		['db', 'db.sqlite'],
	] as const;

	it.each(sacredFiles)('sacred file exists: %s', async (...parts) => {
		const path = join(tmpDir, ...parts);
		const stat = statSync(path);
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBeGreaterThan(0);
	});

	it('secret files have mode 0600 on POSIX', () => {
		if (process.platform === 'win32') return;
		for (const f of [['secrets', 'encryption.key'], ['secrets', 'jwt.key']] as const) {
			const stat = statSync(join(tmpDir, ...f));
			// eslint-disable-next-line no-bitwise
			const mode = stat.mode & 0o777;
			expect(mode, `${f.join('/')} should be 0600`).toBe(0o600);
		}
	});

	it('secrets dir is 0700 on POSIX', () => {
		if (process.platform === 'win32') return;
		const stat = statSync(join(tmpDir, 'secrets'));
		// eslint-disable-next-line no-bitwise
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o700);
	});

	it('encryption key has expected base64 length', () => {
		const v = readFileSync(join(tmpDir, 'secrets', 'encryption.key'), 'utf8').trim();
		// base64(32 bytes) = 44 chars (no padding stripped)
		expect(v.length).toBeGreaterThanOrEqual(40);
		expect(v.length).toBeLessThanOrEqual(50);
	});
});
