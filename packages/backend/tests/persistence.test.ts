/**
 * Persistence-contract test.
 *
 * Per CLAUDE.md §6: enforces that no sacred path under /data/ is mutated
 * by anything other than DB migrations + intentional re-renders.
 *
 * Strategy: spin up a tmp data dir, bootstrap into it, snapshot the SHA256
 * of every sacred file. Run a simulated re-bootstrap (mimics a startup
 * after an update). Re-snapshot and verify nothing changed.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

const SACRED_FILES = [
	['secrets', 'encryption.key'],
	['secrets', 'jwt.key'],
] as const;

function sha256File(...parts: string[]): string {
	const path = join(tmpDir, ...parts);
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-persist-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`setup bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('persistence contract', () => {
	it('sacred file SHA256 is stable across a second bootstrap (simulated reboot)', async () => {
		const before: Record<string, string> = {};
		for (const parts of SACRED_FILES) {
			before[parts.join('/')] = sha256File(...parts);
		}

		// Simulate a reboot: close DB, re-run bootstrap
		const { closeDb } = await import('../src/db/db.js');
		await closeDb();

		const { runBootstrap } = await import('../src/bootstrap.js?cachebust=' + Math.random());
		const status = await runBootstrap();
		expect(status.complete).toBe(true);

		for (const parts of SACRED_FILES) {
			const after = sha256File(...parts);
			expect(after, `${parts.join('/')} changed across bootstrap`).toBe(before[parts.join('/')]);
		}
	});

	it('sacred file permissions remain 0600 on POSIX', () => {
		if (process.platform === 'win32') return;
		for (const parts of SACRED_FILES) {
			const stat = statSync(join(tmpDir, ...parts));
			// eslint-disable-next-line no-bitwise
			const mode = stat.mode & 0o777;
			expect(mode, `${parts.join('/')} should be mode 0600`).toBe(0o600);
		}
	});

	it('db file is not deleted by re-bootstrap', async () => {
		const dbPath = join(tmpDir, 'db', 'db.sqlite');
		const beforeSize = statSync(dbPath).size;

		const { closeDb } = await import('../src/db/db.js');
		await closeDb();

		const { runBootstrap } = await import('../src/bootstrap.js?cachebust=' + Math.random());
		await runBootstrap();

		// File must still exist and not be empty
		expect(statSync(dbPath).size).toBeGreaterThanOrEqual(beforeSize);
	});

	// TODO(M6): fs.watch-based assertion that during a simulated update run,
	// no write events fire on /data/secrets/, /data/cloudflared/*.json, etc.
	// Requires apply-update.sh to be runnable in a non-Docker test env (mock).
});
