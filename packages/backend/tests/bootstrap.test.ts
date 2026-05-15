/**
 * Bootstrap test suite (skeleton).
 *
 * Per CLAUDE.md §6: this test must stay green. It guards against:
 *   - regenerating secrets when files exist
 *   - destroying user data on second boot
 *   - failing to recover from a partially-set-up /data dir
 *
 * Full implementation lands in M1. For M0 we have placeholder tests so the
 * test file exists and CI doesn't error on "no tests".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDataDir: string;

beforeAll(async () => {
	tmpDataDir = await mkdtemp(join(tmpdir(), 'cloudgate-bootstrap-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDataDir;
});

afterAll(async () => {
	if (tmpDataDir) {
		await rm(tmpDataDir, { recursive: true, force: true });
	}
});

describe('bootstrap', () => {
	it('placeholder: real tests land in M1', () => {
		// TODO(M1):
		//  - it('generates secrets on empty /data')
		//  - it('does NOT regenerate existing secrets')
		//  - it('seeds admin only on empty users table')
		//  - it('writes /data/.bootstrap-complete marker on success')
		//  - it('writes /data/.bootstrap-error marker on failure')
		//  - it('survives a partially-corrupted /data')
		expect(true).toBe(true);
	});
});
