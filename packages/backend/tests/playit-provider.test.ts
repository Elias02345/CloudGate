/**
 * PlayitProvider — addHost wiring (with a mocked playit API).
 *
 * We bootstrap a temporary SQLite DB, insert a fake playit_accounts row +
 * tunnels row, replace the playit API with an in-memory fake, and verify
 * addHost picks the right tunnel type and edge endpoint and reuses tunnels.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-playit-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	// The fake rows below reference user_id: 1 under a NOT NULL FK to
	// users(id). Bootstrap only seeds that row for a headless install (env
	// var set); see bootstrap.ts `seedAdminIfMissing`.
	process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD = 'unit-test-initial-pw-123456';
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, 'CLOUDGATE_INITIAL_ADMIN_PASSWORD');
});

interface FakeTunnel {
	id: string;
	tunnel_type: string | null;
	port_type: 'tcp' | 'udp';
	local_ip: string;
	local_port: number;
}

const fake = vi.hoisted(() => ({
	tunnels: new Map<string, FakeTunnel>(),
	created: 0,
	deleted: 0,
	agentNotConnected: false,
}));

vi.mock('../src/services/tunnel-providers/playit/client.js', async () => {
	return {
		PlayitApiError: class PlayitApiError extends Error {
			constructor(
				public status: number,
				public code: string,
				message: string
			) {
				super(message);
			}
		},
		createPlayitClient: () => ({
			runData: async () => ({ agent_id: 'agent-1', account_status: 'ready' }),
			listTunnels: async (id?: string) => ({
				tunnels: [...fake.tunnels.values()]
					.filter((t) => !id || t.id === id)
					.map((t) => ({
						...t,
						name: null,
						disabled_reason: null,
						allocation: {
							assigned_domain: 'mc-mock.joinmc.link',
							ip_hostname: 'ip-mock.gl.ply.gg',
							port_start: t.port_type === 'tcp' ? 54321 : 54322,
						},
					})),
				tcp: { allowed: 4, claimed: 0 },
				udp: { allowed: 4, claimed: 0 },
			}),
			createTunnel: async (input: Omit<FakeTunnel, 'id'>) => {
				if (fake.agentNotConnected) {
					fake.agentNotConnected = false;
					const { PlayitApiError } = await import('../src/services/tunnel-providers/playit/client.js');
					throw new PlayitApiError(400, 'AgentVersionTooOld', 'agent never connected');
				}
				fake.created++;
				const id = `mock-${fake.created}`;
				fake.tunnels.set(id, {
					id,
					tunnel_type: input.tunnel_type,
					port_type: input.port_type,
					local_ip: input.local_ip,
					local_port: input.local_port,
				});
				return id;
			},
			deleteTunnel: async (id: string) => {
				fake.deleted++;
				fake.tunnels.delete(id);
			},
		}),
	};
});

async function makeTunnel(label: string): Promise<number> {
	const { getDb } = await import('../src/db/db.js');
	const { encryptJson } = await import('../src/services/crypto.js');
	const knex = getDb();
	const now = new Date().toISOString();
	// User id 1 was seeded by bootstrap admin.
	const [accountId] = await knex('playit_accounts').insert({
		user_id: 1,
		label,
		encrypted_secret_key: encryptJson({ type: 'playit', secret: `fake-${label}` }),
		status: 'active',
		last_validated_at: now,
		created_at: now,
	});
	const [tunnelId] = await knex('tunnels').insert({
		cloudflare_account_id: null,
		playit_account_id: accountId,
		provider: 'playit',
		provider_meta: JSON.stringify({ playit_account_id: accountId, hosts: {} }),
		tunnel_id: `playit-${label}`,
		name: label,
		account_tag: null,
		encrypted_tunnel_secret: null,
		credentials_path: null,
		status: 'stopped',
		last_status_at: now,
		created_at: now,
	});
	return Number(tunnelId);
}

const javaHost = {
	id: 999,
	hostname: 'play.example.com',
	protocol: 'tcp' as const,
	forward_host: '192.168.1.50',
	forward_port: 25565,
	forward_scheme: 'http' as const,
	host_type: 'minecraft_java',
};

describe('PlayitProvider.addHost', () => {
	it('Minecraft Java without a zone: minecraft-java tunnel, free playit address', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('java');
		const edge = await new PlayitProvider().addHost(tunnelId, javaHost);

		expect(edge).toEqual({ kind: 'host_port', target: 'mc-mock.joinmc.link', port: 54321 });
		const created = [...fake.tunnels.values()].at(-1);
		expect(created?.tunnel_type).toBe('minecraft-java');
		expect(created?.local_port).toBe(25565);
	});

	it('Minecraft Java with a zone: SRV record pointing at the tunnel IP hostname', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('java-zone');
		const edge = await new PlayitProvider().addHost(tunnelId, { ...javaHost, id: 998, has_zone: true });

		expect(edge).toEqual({
			kind: 'srv',
			service: '_minecraft',
			proto: '_tcp',
			target: 'ip-mock.gl.ply.gg',
			port: 54321,
		});
	});

	it('redeploy reuses the tunnel; an origin change replaces it', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('idem');
		const provider = new PlayitProvider();

		await provider.addHost(tunnelId, javaHost);
		const createdBefore = fake.created;
		await provider.addHost(tunnelId, javaHost);
		expect(fake.created).toBe(createdBefore);

		const deletedBefore = fake.deleted;
		await provider.addHost(tunnelId, { ...javaHost, forward_port: 25566 });
		expect(fake.created).toBe(createdBefore + 1);
		expect(fake.deleted).toBe(deletedBefore + 1);
	});

	it('starts the agent and retries while playit reports AgentVersionTooOld', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('fresh-agent');
		const provider = new PlayitProvider();
		const start = vi.spyOn(provider, 'start').mockResolvedValue();
		fake.agentNotConnected = true;

		const edge = await provider.addHost(tunnelId, { ...javaHost, id: 997 });

		expect(start).toHaveBeenCalledWith(tunnelId);
		expect(edge.kind).toBe('host_port');
	}, 15_000);

	it('Bedrock (UDP): minecraft-bedrock tunnel, host_port endpoint', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('udp');
		const edge = await new PlayitProvider().addHost(tunnelId, {
			id: 1000,
			hostname: 'mc.example.com',
			protocol: 'udp',
			forward_host: '192.168.1.50',
			forward_port: 19132,
			forward_scheme: 'http',
			host_type: 'minecraft_bedrock',
		});

		expect(edge).toEqual({ kind: 'host_port', target: 'mc-mock.joinmc.link', port: 54322 });
		expect([...fake.tunnels.values()].at(-1)?.tunnel_type).toBe('minecraft-bedrock');
	});

	it('rejects http protocol — not supported', async () => {
		const { PlayitProvider } = await import('../src/services/tunnel-providers/playit/provider.js');
		const tunnelId = await makeTunnel('reject');
		await expect(
			new PlayitProvider().addHost(tunnelId, {
				id: 1001,
				hostname: 'web.example.com',
				protocol: 'http',
				forward_host: '192.168.1.50',
				forward_port: 80,
				forward_scheme: 'http',
			})
		).rejects.toThrow(/does not support protocol 'http'/);
	});
});
