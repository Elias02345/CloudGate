/**
 * Guards the playit-agent download pins.
 *
 * This table decides which bytes CloudGate makes executable and runs. It
 * previously carried `__pin_me__` placeholders against a `releases/latest`
 * URL, and the verification code skipped the check whenever it saw the
 * placeholder — so an unverified binary was downloaded, chmod +x'd and
 * spawned. These assertions exist so that combination cannot come back
 * unnoticed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BINARIES } from '../src/services/playit-binary.js';

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-playit-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('playit-agent binary pins', () => {
	const entries = Object.entries(BINARIES).filter(([, meta]) => meta !== undefined) as [
		string,
		{ url: string; sha256: string },
	][];

	it('has at least the linux targets CloudGate actually ships on', () => {
		const keys = entries.map(([k]) => k);
		expect(keys).toContain('linux-x64');
		expect(keys).toContain('linux-arm64');
	});

	it.each(entries)('%s pins a real sha256', (_key, meta) => {
		expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each(entries)('%s downloads from an exact release tag, not a moving URL', (_key, meta) => {
		expect(meta.url).toMatch(/^https:\/\/github\.com\/playit-cloud\/playit-agent\/releases\/download\/v/);
		expect(meta.url).not.toContain('releases/latest');
	});

	it('lists no target it cannot verify', () => {
		for (const [, meta] of Object.entries(BINARIES)) {
			if (!meta) continue; // an unsupported platform is absent, not placeheld
			expect(meta.sha256).not.toBe('__pin_me__');
		}
	});
});
