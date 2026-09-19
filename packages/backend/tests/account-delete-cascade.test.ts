/**
 * What deleting a provider account does to the tunnels and hosts underneath it.
 *
 * `tunnels.cloudflare_account_id` is declared `ON DELETE CASCADE`, and
 * `foreign_keys` is ON (see db/db.ts). So removing a Cloudflare account makes
 * every tunnel row on it disappear inside SQLite — without ever entering
 * `DELETE /tunnels/:id`, which is the only place that stops the daemon,
 * deletes the tunnel at Cloudflare and removes its credentials file.
 *
 * `proxy_hosts.tunnel_id` is `ON DELETE SET NULL`, so the hosts survive with
 * no tunnel — the orphaned state migration 008 exists to clean up after.
 *
 * These tests pin the shape of that cascade against a real migrated database,
 * so the teardown built on top of it cannot be quietly removed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;
/** Imported once here: pulling in the Cloudflare SDK costs seconds the first
 * time, which would otherwise be charged to whichever test happened to be first. */
let destroyTunnelsForAccount: typeof import('../src/services/tunnel-teardown.js')['destroyTunnelsForAccount'];

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-cascade-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
	({ destroyTunnelsForAccount } = await import('../src/services/tunnel-teardown.js'));
	// Bootstrap plus the Cloudflare SDK's first import: ~9s alone, and past
	// vitest's 10s hook default when the rest of the suite runs alongside —
	// which skipped the whole file instead of failing it.
}, 60_000);

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** The seeded admin from bootstrap. */
const USER_ID = 1;

/** One account + one tunnel + one host attached to it. Returns their ids. */
async function seedAccountWithTunnelAndHost(
	label: string
): Promise<{ accountId: number; tunnelId: number; hostId: number; uuid: string }> {
	const { getDb } = await import('../src/db/db.js');
	const knex = getDb();
	const now = new Date().toISOString();
	const uuid = `uuid-${label}`;

	const [accountId] = await knex('cloudflare_accounts').insert({
		user_id: USER_ID,
		label,
		auth_type: 'api_token',
		encrypted_credentials: Buffer.from('{}'),
		account_tag: `tag-${label}`,
		created_at: now,
	});
	const [tunnelId] = await knex('tunnels').insert({
		cloudflare_account_id: accountId,
		provider: 'cloudflared',
		tunnel_id: uuid,
		name: `tunnel-${label}`,
		account_tag: `tag-${label}`,
		encrypted_tunnel_secret: Buffer.from('{}'),
		credentials_path: `/data/cloudflared/${uuid}.json`,
		created_at: now,
	});
	const [hostId] = await knex('proxy_hosts').insert({
		tunnel_id: tunnelId,
		mode: 'cloudflare_tunnel',
		hostname: `${label}.example.com`,
		forward_scheme: 'http',
		forward_host: '127.0.0.1',
		forward_port: 8080,
		created_at: now,
		updated_at: now,
	});

	return { accountId, tunnelId, hostId, uuid };
}

describe('deleting a Cloudflare account', () => {
	it('takes every tunnel on it with it, and orphans their hosts', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		const { accountId, tunnelId, hostId } = await seedAccountWithTunnelAndHost('cascade');

		await knex('cloudflare_accounts').where({ id: accountId }).delete();

		// The tunnel row is gone — nothing in the application saw it happen.
		expect(await knex('tunnels').where({ id: tunnelId }).first()).toBeUndefined();

		// The host survives, pointing at nothing.
		const host = await knex('proxy_hosts').where({ id: hostId }).first();
		expect(host).toBeDefined();
		expect(host?.tunnel_id).toBeNull();
	});

	it('the teardown removes the tunnels before the cascade can', async () => {
		// The point of destroyTunnelsForAccount: the rows go through the code
		// that stops the daemon and deletes the tunnel upstream, rather than
		// disappearing underneath the application when the account row goes.
		// Proven by the account still being there afterwards.
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		const { accountId, tunnelId, hostId } = await seedAccountWithTunnelAndHost('teardown');

		const removed = await destroyTunnelsForAccount('cloudflare_account_id', accountId, USER_ID);

		expect(removed).toBe(1);
		expect(await knex('tunnels').where({ id: tunnelId }).first()).toBeUndefined();
		expect(await knex('cloudflare_accounts').where({ id: accountId }).first()).toBeDefined();
		const host = await knex('proxy_hosts').where({ id: hostId }).first();
		expect(host?.tunnel_id).toBeNull();
	});

	it('tears down nothing for an account with no tunnels', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		const now = new Date().toISOString();
		const [accountId] = await knex('cloudflare_accounts').insert({
			user_id: USER_ID,
			label: 'empty',
			auth_type: 'api_token',
			encrypted_credentials: Buffer.from('{}'),
			account_tag: 'tag-empty',
			created_at: now,
		});
		expect(await destroyTunnelsForAccount('cloudflare_account_id', accountId, USER_ID)).toBe(0);
	});

	it('leaves other accounts alone', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		const doomed = await seedAccountWithTunnelAndHost('doomed');
		const keeper = await seedAccountWithTunnelAndHost('keeper');

		await knex('cloudflare_accounts').where({ id: doomed.accountId }).delete();

		expect(await knex('tunnels').where({ id: keeper.tunnelId }).first()).toBeDefined();
		const keptHost = await knex('proxy_hosts').where({ id: keeper.hostId }).first();
		expect(keptHost?.tunnel_id).toBe(keeper.tunnelId);
	});
});
