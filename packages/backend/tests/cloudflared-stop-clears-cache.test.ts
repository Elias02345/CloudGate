/**
 * Regression: CloudflaredProvider.stop() must drop the cached process
 * so the next start() rebuilds with current DB state.
 *
 * The 0.2.2 → 0.2.3 bug ("running but page not found"): after Recreate
 * the tunnels.tunnel_id changes in DB, but the cached CloudflaredProcess
 * still has the OLD UUID frozen in its constructor. cloudflared spawned
 * with the wrong UUID, CF refused traffic to it, /ready stayed 200 (the
 * metrics port works regardless of CF connectivity), UI showed "running",
 * but every hostname returned 404.
 *
 * We don't actually spawn cloudflared in this test — we just verify the
 * cache is empty after stop(). That's the contract the fix depends on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-cfstop-'));
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

describe('CloudflaredProvider stop() cache invalidation', () => {
	it('drops the cached process so the next start() rebuilds fresh', async () => {
		const { CloudflaredProvider } = await import('../src/services/tunnel-providers/cloudflared/provider.js');
		const provider = new CloudflaredProvider();
		// biome-ignore lint/suspicious/noExplicitAny: peek into the private map for the regression assertion
		const cache: Map<number, unknown> = (provider as any).processes;

		// Manually plant a fake process instance so we can detect it being
		// dropped. Real code paths construct CloudflaredProcess inside
		// start() — we skip that for this test's isolation.
		const fakeProc = {
			stop: async () => {
				/* noop */
			},
			currentStatus: 'stopped',
		};
		cache.set(42, fakeProc);
		expect(cache.has(42)).toBe(true);

		await provider.stop(42);
		expect(cache.has(42)).toBe(false);
	});

	it('stop() on a not-cached id is a no-op (idempotent)', async () => {
		const { CloudflaredProvider } = await import('../src/services/tunnel-providers/cloudflared/provider.js');
		const provider = new CloudflaredProvider();
		await expect(provider.stop(9999)).resolves.toBeUndefined();
	});
});
