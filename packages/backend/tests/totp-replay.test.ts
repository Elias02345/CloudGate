/**
 * TOTP single-use enforcement, against a real migrated SQLite database.
 *
 * otplib accepts a code for its whole 30-second step, any number of times.
 * RFC 6238 §5.2 says a verifier must accept a given step only once —
 * otherwise a code someone watched you type stays a live credential for the
 * rest of its window.
 *
 * Running this through `runBootstrap()` also proves the two migrations this
 * release adds actually apply to a fresh database, which a pure unit test
 * would not.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-totp-'));
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

/** The seeded admin from bootstrap. */
const USER_ID = 1;

describe('totpStepFor', () => {
	it('advances once every 30 seconds', async () => {
		const { totpStepFor } = await import('../src/services/auth.js');
		const base = 1_800_000_000_000;
		expect(totpStepFor(base)).toBe(totpStepFor(base + 29_999));
		expect(totpStepFor(base + 30_000)).toBe(totpStepFor(base) + 1);
	});
});

describe('claimTotpStep', () => {
	it('accepts a step once and refuses the same step afterwards', async () => {
		const { claimTotpStep } = await import('../src/services/auth.js');
		const step = 50_000_000;

		expect(await claimTotpStep(USER_ID, step)).toBe(true);
		expect(await claimTotpStep(USER_ID, step)).toBe(false);
	});

	it('accepts the next step', async () => {
		const { claimTotpStep } = await import('../src/services/auth.js');
		expect(await claimTotpStep(USER_ID, 50_000_001)).toBe(true);
	});

	it('refuses an older step, so a captured code cannot be wound back', async () => {
		const { claimTotpStep } = await import('../src/services/auth.js');
		expect(await claimTotpStep(USER_ID, 49_999_999)).toBe(false);
	});

	it('lets only one of two simultaneous claims win', async () => {
		const { claimTotpStep } = await import('../src/services/auth.js');
		const step = 50_000_050;
		// The check and the write are one conditional UPDATE precisely so that
		// two requests carrying the same code cannot both pass.
		const results = await Promise.all([claimTotpStep(USER_ID, step), claimTotpStep(USER_ID, step)]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it('starts from NULL on a fresh install rather than locking the user out', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		await knex('users').where({ id: USER_ID }).update({ totp_last_step: null });
		const { claimTotpStep } = await import('../src/services/auth.js');
		expect(await claimTotpStep(USER_ID, 1)).toBe(true);
	});
});
