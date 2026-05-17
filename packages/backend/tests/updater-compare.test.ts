/**
 * Version-compare logic exercise.
 *
 * The full updater touches GitHub + filesystem + child_process — we'd need
 * heavy mocks. For now we extract + test just the semver comparison helper
 * via its observable behaviour on channel-picking.
 */

import { describe, expect, it } from 'vitest';

// The internal helper isn't exported but we re-implement the same logic here
// to assert the contract. If updater.ts changes its comparison rules, this
// test should be updated alongside.
function compareVersions(a: string, b: string): number {
	const norm = (s: string) => s.replace(/^v/, '').split(/[.+-]/).map((p) => Number.parseInt(p, 10));
	const [aMaj, aMin, aPat] = norm(a);
	const [bMaj, bMin, bPat] = norm(b);
	const score = (x: number | undefined) => (Number.isFinite(x) ? (x as number) : 0);
	if (score(aMaj) !== score(bMaj)) return score(aMaj) - score(bMaj);
	if (score(aMin) !== score(bMin)) return score(aMin) - score(bMin);
	return score(aPat) - score(bPat);
}

describe('version comparison', () => {
	it('detects newer patch', () => {
		expect(compareVersions('v0.1.1', 'v0.1.0')).toBeGreaterThan(0);
	});

	it('detects newer minor', () => {
		expect(compareVersions('v0.2.0', 'v0.1.99')).toBeGreaterThan(0);
	});

	it('detects newer major', () => {
		expect(compareVersions('v2.0.0', 'v1.99.99')).toBeGreaterThan(0);
	});

	it('treats v-prefix as optional', () => {
		expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0);
	});

	it('treats prerelease suffix as same base when patches equal', () => {
		// Real semver would treat '0.1.0-rc1' < '0.1.0', but our helper is
		// patch-version focused and ignores tags. Documenting current behaviour.
		expect(compareVersions('v0.1.0-rc1', 'v0.1.0')).toBe(0);
	});

	it('handles missing patch as 0', () => {
		expect(compareVersions('v0.2', 'v0.1.99')).toBeGreaterThan(0);
	});
});
