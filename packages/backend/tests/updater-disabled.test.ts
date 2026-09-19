/**
 * CLOUDGATE_DISABLE_UPDATES UX contract.
 *
 * App-store platforms (Umbrel, TrueNAS, Unraid, ZimaOS) own the image and set
 * this env var because an in-app self-update racing the platform re-pinning
 * the old image would run old code against a newer DB schema. The API must
 * surface that state (`updates_disabled`) so the frontend can hide controls
 * that cannot work, and must refuse an install even if something still calls
 * the endpoint directly (e.g. via an API key).
 *
 * updater.ts caches config/state at module scope, so each case re-imports it
 * fresh (vi.resetModules) after setting the env var, same pattern as
 * config-env-boolean.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUpdaterWith(disabled: boolean | undefined) {
	// process.env isn't a plain object: assigning `undefined` stores the
	// *string* "undefined" instead of unsetting the key, which would break
	// the "unset" case below — delete is the only correct way to clear it.
	// biome-ignore lint/performance/noDelete: see comment above.
	delete process.env.CLOUDGATE_DISABLE_UPDATES;
	if (disabled !== undefined) process.env.CLOUDGATE_DISABLE_UPDATES = String(disabled);
	vi.resetModules();
	return import('../src/services/updater.js');
}

describe('updates disabled via CLOUDGATE_DISABLE_UPDATES', () => {
	afterEach(() => {
		// biome-ignore lint/performance/noDelete: see loadUpdaterWith above.
		delete process.env.CLOUDGATE_DISABLE_UPDATES;
	});

	// A generous timeout on each case: vi.resetModules() forces a cold
	// re-import of updater.js's dependency chain (knex, better-sqlite3's
	// native binding, argon2) every time, which is slow on first touch —
	// unrelated to the assertion itself.
	const CASE_TIMEOUT = 30_000;

	it(
		'getStatus().updates_disabled is false by default',
		async () => {
			const updater = await loadUpdaterWith(undefined);
			expect(updater.getStatus().updates_disabled).toBe(false);
		},
		CASE_TIMEOUT
	);

	it(
		'getStatus().updates_disabled reflects the env var',
		async () => {
			const updater = await loadUpdaterWith(true);
			expect(updater.getStatus().updates_disabled).toBe(true);
		},
		CASE_TIMEOUT
	);

	it(
		'triggerInstall rejects instead of dispatching an install',
		async () => {
			const updater = await loadUpdaterWith(true);
			await expect(updater.triggerInstall('1.2.3')).rejects.toThrow(/disabled/i);
		},
		CASE_TIMEOUT
	);

	it(
		'triggerCheck is a no-op and does not flip state away from idle',
		async () => {
			const updater = await loadUpdaterWith(true);
			await updater.triggerCheck();
			expect(updater.getStatus().state).toBe('idle');
		},
		CASE_TIMEOUT
	);
});
