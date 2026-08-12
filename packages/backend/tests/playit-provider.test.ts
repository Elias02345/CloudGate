/**
 * PlayitProvider — addHost wiring (with a mocked REST client).
 *
 * We bootstrap a temporary SQLite DB, insert a fake playit_accounts row +
 * tunnels row, stub the createPlayitClient module, and verify addHost
 * returns the right edge endpoint shape for TCP (SRV) and UDP (host_port).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-playit-'));
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

vi.mock('../src/services/tunnel-providers/playit/client.js', async () => {
	return {
		PLAYIT_FREE_TIER: { TCP: 4, UDP: 4 },
		PlayitApiError: class PlayitApiError extends Error {
			status = 0;
			code = '';
		},
		createPlayitClient: () => ({
			verify: async () => ({ verified: true, tcp_used: 0, udp_used: 0 }),
			listTunnels: async () => [],
			createTunnel: async (input: { protocol: 'tcp' | 'udp'; name: string }) => ({
				tunnel_uuid: `mock-${input.name}`,
				assigned_host: 'mc-mock.joinmc.link',
				assigned_port: input.protocol === 'tcp' ? 54321 : 54322,
				protocol: input.protocol,
			}),
			deleteTunnel: async () => {
				/* noop */
			},
		}),
	};
});

describe('PlayitProvider.addHost', () => {
	it('returns SRV endpoint for TCP (Minecraft Java)', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { encryptJson } = await import('../src/services/crypto.js');
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');

		const knex = getDb();
		const now = new Date().toISOString();
		// User id 1 was seeded by bootstrap admin.
		const [accountId] = await knex('playit_accounts').insert({
			user_id: 1,
			label: 'test',
			encrypted_secret_key: encryptJson({ type: 'playit', secret: 'fake-secret' }),
			status: 'active',
			last_validated_at: now,
			created_at: now,
		});
		const meta = { playit_account_id: accountId, hosts: {} };
		const [tunnelId] = await knex('tunnels').insert({
			cloudflare_account_id: null,
			playit_account_id: accountId,
			provider: 'playit',
			provider_meta: JSON.stringify(meta),
			tunnel_id: 'playit-test',
			name: 'test',
			account_tag: null,
			encrypted_tunnel_secret: null,
			credentials_path: null,
			status: 'stopped',
			last_status_at: now,
			created_at: now,
		});

		const provider = new PlayitProvider();
		const edge = await provider.addHost(Number(tunnelId), {
			id: 999,
			hostname: 'play.example.com',
			protocol: 'tcp',
			forward_host: '192.168.1.50',
			forward_port: 25565,
			forward_scheme: 'http',
		});

		expect(edge.kind).toBe('srv');
		if (edge.kind === 'srv') {
			expect(edge.service).toBe('_minecraft');
			expect(edge.proto).toBe('_tcp');
			expect(edge.target).toBe('mc-mock.joinmc.link');
			expect(edge.port).toBe(54321);
		}
	});

	it('returns host_port endpoint for UDP (Minecraft Bedrock)', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { encryptJson } = await import('../src/services/crypto.js');
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');

		const knex = getDb();
		const now = new Date().toISOString();
		const [accountId] = await knex('playit_accounts').insert({
			user_id: 1,
			label: 'test-udp',
			encrypted_secret_key: encryptJson({ type: 'playit', secret: 'fake-udp-secret' }),
			status: 'active',
			last_validated_at: now,
			created_at: now,
		});
		const meta = { playit_account_id: accountId, hosts: {} };
		const [tunnelId] = await knex('tunnels').insert({
			cloudflare_account_id: null,
			playit_account_id: accountId,
			provider: 'playit',
			provider_meta: JSON.stringify(meta),
			tunnel_id: 'playit-test-udp',
			name: 'test-udp',
			account_tag: null,
			encrypted_tunnel_secret: null,
			credentials_path: null,
			status: 'stopped',
			last_status_at: now,
			created_at: now,
		});

		const provider = new PlayitProvider();
		const edge = await provider.addHost(Number(tunnelId), {
			id: 1000,
			hostname: 'mc.example.com',
			protocol: 'udp',
			forward_host: '192.168.1.50',
			forward_port: 19132,
			forward_scheme: 'http',
		});

		expect(edge.kind).toBe('host_port');
		if (edge.kind === 'host_port') {
			expect(edge.target).toBe('mc-mock.joinmc.link');
			expect(edge.port).toBe(54322);
		}
	});

	it('rejects http protocol — not supported', async () => {
		const { getDb } = await import('../src/db/db.js');
		const { encryptJson } = await import('../src/services/crypto.js');
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');

		const knex = getDb();
		const now = new Date().toISOString();
		const [accountId] = await knex('playit_accounts').insert({
			user_id: 1,
			label: 'reject',
			encrypted_secret_key: encryptJson({ type: 'playit', secret: 'fake' }),
			status: 'active',
			last_validated_at: now,
			created_at: now,
		});
		const meta = { playit_account_id: accountId, hosts: {} };
		const [tunnelId] = await knex('tunnels').insert({
			cloudflare_account_id: null,
			playit_account_id: accountId,
			provider: 'playit',
			provider_meta: JSON.stringify(meta),
			tunnel_id: 'playit-reject',
			name: 'reject',
			account_tag: null,
			encrypted_tunnel_secret: null,
			credentials_path: null,
			status: 'stopped',
			last_status_at: now,
			created_at: now,
		});

		const provider = new PlayitProvider();
		await expect(
			provider.addHost(Number(tunnelId), {
				id: 1001,
				hostname: 'web.example.com',
				protocol: 'http',
				forward_host: '192.168.1.50',
				forward_port: 80,
				forward_scheme: 'http',
			}),
		).rejects.toThrow(/does not support protocol 'http'/);
	});
});
