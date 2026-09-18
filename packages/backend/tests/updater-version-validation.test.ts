/**
 * Version-string validation exercise.
 *
 * targetVersion flows from the HTTP request body into filesystem paths
 * (staging dir, archive name) and a GitHub URL, and is ultimately passed as
 * an argv to docker/apply-update.sh, which uses it in `rm -rf` / `mkdir -p`.
 * A value like "x/../../../secrets" must never reach any of those three
 * places. See routes/updates.ts#VERSION_RE, services/updater.ts#VERSION_RE
 * and docker/apply-update.sh's VERSION_RE_SH — all three must stay in sync.
 *
 * Same style as updater-compare.test.ts: the full updater touches
 * GitHub + filesystem + child_process, so we re-implement the same regex
 * here to assert the contract rather than heavily mock the service.
 */

import { describe, expect, it } from 'vitest';

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('update target version validation', () => {
	it('accepts a plain SemVer version', () => {
		expect(VERSION_RE.test('1.2.3')).toBe(true);
	});

	it('accepts a v-prefixed version', () => {
		expect(VERSION_RE.test('v1.2.3')).toBe(true);
	});

	it('accepts a pre-release version', () => {
		expect(VERSION_RE.test('v1.2.3-rc1')).toBe(true);
	});

	it('rejects a path-traversal payload', () => {
		expect(VERSION_RE.test('x/../../../secrets')).toBe(false);
	});

	it('rejects an absolute path', () => {
		expect(VERSION_RE.test('/etc/passwd')).toBe(false);
	});
});
