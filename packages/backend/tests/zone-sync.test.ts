/**
 * Regression test for the "orphaned hosts on zone re-sync" bug.
 *
 * Root cause: doZoneSync used to DELETE all cf_zones for an account and
 * re-INSERT them, handing every zone a fresh auto-increment id. Because
 * proxy_hosts.cf_zone_id references cf_zones.id with ON DELETE SET NULL,
 * every host attached to a zone had its cf_zone_id NULLed on every sync —
 * so a host that "worked yesterday" silently lost its zone binding and
 * stopped publishing DNS. syncZonesForAccount() must upsert instead.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-zonesync-'));
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

async function makeAccount(label: string, tag: string): Promise<number> {
	const { getDb } = await import('../src/db/db.js');
	const knex = getDb();
	const [id] = await knex('cloudflare_accounts').insert({
		user_id: 1,
		label,
		auth_type: 'api_token',
		encrypted_credentials: Buffer.from('x'),
		account_tag: tag,
		created_at: new Date().toISOString(),
	});
	return Number(id);
}

describe('syncZonesForAccount', () => {
	it('keeps proxy_hosts.cf_zone_id intact when the same zone is re-synced', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { syncZonesForAccount } = await import('../src/services/cf-account.js');
		const knex = getDb();
		const accountId = await makeAccount('acct', 'tag-a');

		await syncZonesForAccount(accountId, [{ id: 'zoneA', name: 'a.example.com', status: 'active' }]);
		const zone = await knex('cf_zones').where({ cloudflare_account_id: accountId, zone_id: 'zoneA' }).first();
		expect(zone).toBeTruthy();

		const now = new Date().toISOString();
		const [hostId] = await knex('proxy_hosts').insert({
			cf_zone_id: zone.id,
			mode: 'cloudflare_tunnel',
			hostname: 'a.example.com',
			forward_scheme: 'http',
			forward_host: '127.0.0.1',
			forward_port: 8080,
			created_at: now,
			updated_at: now,
		});

		// Re-sync the SAME zone — the old delete+reinsert NULLed cf_zone_id here.
		await syncZonesForAccount(accountId, [{ id: 'zoneA', name: 'a.example.com', status: 'active' }]);

		const host = await knex('proxy_hosts').where({ id: hostId }).first();
		expect(host.cf_zone_id).toBe(zone.id);
	});

	it('prunes zones Cloudflare no longer returns', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { syncZonesForAccount } = await import('../src/services/cf-account.js');
		const knex = getDb();
		const accountId = await makeAccount('acct2', 'tag-b');

		await syncZonesForAccount(accountId, [
			{ id: 'z1', name: 'one.com', status: 'active' },
			{ id: 'z2', name: 'two.com', status: 'active' },
		]);
		await syncZonesForAccount(accountId, [{ id: 'z1', name: 'one.com', status: 'active' }]);

		const remaining = await knex('cf_zones')
			.where({ cloudflare_account_id: accountId })
			.orderBy('zone_id')
			.select('zone_id');
		expect(remaining.map((r: { zone_id: string }) => r.zone_id)).toEqual(['z1']);
	});
});
