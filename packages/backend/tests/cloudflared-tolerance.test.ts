/**
 * cloudflared provider: missing credentials must not crash boot.
 *
 * Reproduces the failure mode from the 0.2.0 → 0.2.1 hotfix: a tunnel
 * row with provider='cloudflared' but missing encrypted_tunnel_secret
 * (data corruption after a botched alter-table). start() should NOT
 * throw — it should persist a "needs relink" error into provider_meta
 * and return cleanly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-cftol-'));
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

describe('CloudflaredProvider.start tolerance', () => {
	it('does not throw when encrypted_tunnel_secret is missing', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { CloudflaredProvider } = await import('../src/services/tunnel-providers/cloudflared/provider.js');

		const knex = getDb();
		const now = new Date().toISOString();
		// Seed a CF account so the tunnel FK is satisfiable.
		const [accountId] = await knex('cloudflare_accounts').insert({
			user_id: 1,
			label: 'tol-test',
			auth_type: 'api_token',
			encrypted_credentials: 'irrelevant',
			account_tag: 'fake-tag',
			created_at: now,
		});
		// Insert a tunnel row that LOOKS like a 0.2.0 casualty.
		const [tunnelId] = await knex('tunnels').insert({
			cloudflare_account_id: accountId,
			provider: 'cloudflared',
			provider_meta: '{}',
			tunnel_id: 'fake-uuid-0000',
			name: 'broken-tunnel',
			// account_tag intentionally NULL — the breakage signature.
			account_tag: null,
			encrypted_tunnel_secret: null,
			credentials_path: null,
			status: 'starting',
			last_status_at: now,
			created_at: now,
		});

		const provider = new CloudflaredProvider();
		// Must not throw — instead, surfaces error via provider_meta.
		await expect(provider.start(Number(tunnelId))).resolves.toBeUndefined();

		const row = await knex<{ status: string; provider_meta: string }>('tunnels')
			.where({ id: tunnelId })
			.select('status', 'provider_meta')
			.first();
		expect(row?.status).toBe('error');
		expect(row?.provider_meta).toContain('last_error');
		expect(row?.provider_meta).toContain('Re-link');
	});
});
