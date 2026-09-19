/**
 * `z.coerce.boolean()` casts with JS's `Boolean(value)` — any non-empty
 * string, including the literal word "false", is truthy. That made
 * `CLOUDGATE_DISABLE_UPDATES=false` coerce to `true` and silently disable
 * updates for anyone who set the variable explicitly instead of omitting it.
 * config.ts now parses boolean env vars with an explicit word list — this
 * guards the exact regression and the accepted value set.
 *
 * getConfig() caches its result in a module-level variable, so each case
 * re-imports the module fresh (vi.resetModules) rather than sharing state.
 */

import { afterEach, describe, expect, it } from 'vitest';

const ENV_KEYS = ['CLOUDGATE_DISABLE_UPDATES', 'CLOUDGATE_RECOVERY_MODE'] as const;

async function loadConfigWith(value: string | undefined) {
	for (const key of ENV_KEYS) delete process.env[key];
	if (value !== undefined) process.env.CLOUDGATE_DISABLE_UPDATES = value;

	const { vi } = await import('vitest');
	vi.resetModules();
	const { getConfig } = await import('../src/config.js');
	return getConfig();
}

describe('config.ts boolean env parsing', () => {
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	it('defaults to false when unset', async () => {
		expect((await loadConfigWith(undefined)).CLOUDGATE_DISABLE_UPDATES).toBe(false);
	});

	it('"false" parses to false — the exact regression', async () => {
		expect((await loadConfigWith('false')).CLOUDGATE_DISABLE_UPDATES).toBe(false);
	});

	it('"0", "no", "off" and "" all parse to false', async () => {
		for (const v of ['0', 'no', 'off', '']) {
			expect((await loadConfigWith(v)).CLOUDGATE_DISABLE_UPDATES, `value=${JSON.stringify(v)}`).toBe(false);
		}
	});

	it('"true", "1", "yes", "on" all parse to true (case-insensitive)', async () => {
		for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
			expect((await loadConfigWith(v)).CLOUDGATE_DISABLE_UPDATES, `value=${JSON.stringify(v)}`).toBe(true);
		}
	});

	it('an unrecognised value falls back to the default rather than throwing', async () => {
		expect((await loadConfigWith('maybe')).CLOUDGATE_DISABLE_UPDATES).toBe(false);
	});
});
