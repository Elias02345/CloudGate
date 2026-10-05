/**
 * playit API client — request shape and response envelope handling, checked
 * against the official agent's api_client (POST, `Agent-Key` auth,
 * `{status, data}` envelope).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayitApiError, createPlayitClient } from '../src/services/tunnel-providers/playit/client.js';

function mockFetch(body: unknown, status = 200) {
	const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', fn);
	return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('playit client', () => {
	it('POSTs with Agent-Key auth and unwraps a success envelope', async () => {
		const fetchFn = mockFetch({ status: 'success', data: { agent_id: 'a1', account_status: 'ready' } });
		const data = await createPlayitClient(' secret123 ').runData();

		expect(data.agent_id).toBe('a1');
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.playit.gg/agents/rundata');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Agent-Key secret123');
	});

	it('maps a fail envelope to PlayitApiError with the playit error name', async () => {
		mockFetch({ status: 'fail', data: 'RequiresPlayitPremium' });
		const err = await createPlayitClient('k')
			.createTunnel({
				name: 'x',
				tunnel_type: null,
				port_type: 'tcp',
				agent_id: 'a1',
				local_ip: '127.0.0.1',
				local_port: 22,
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(PlayitApiError);
		expect(err.code).toBe('RequiresPlayitPremium');
	});

	it('maps an auth error envelope', async () => {
		mockFetch({ status: 'error', data: { type: 'auth', message: 'InvalidAgentKey' } }, 401);
		const err = await createPlayitClient('bad')
			.runData()
			.catch((e) => e);
		expect(err.code).toBe('auth:InvalidAgentKey');
		expect(err.status).toBe(401);
	});

	it('flattens allocated tunnels and port usage from /tunnels/list', async () => {
		mockFetch({
			status: 'success',
			data: {
				tunnels: [
					{
						id: 't1',
						name: 'mc',
						tunnel_type: 'minecraft-java',
						port_type: 'tcp',
						alloc: {
							status: 'allocated',
							data: { assigned_domain: 'x.joinmc.link', ip_hostname: 'ip.ply.gg', port_start: 1234 },
						},
						origin: { type: 'agent', data: { local_ip: '10.0.0.2', local_port: 25565 } },
						disabled_reason: null,
					},
					{
						id: 't2',
						name: null,
						tunnel_type: null,
						port_type: 'udp',
						alloc: { status: 'pending' },
						origin: null,
						disabled_reason: null,
					},
				],
				tcp_alloc: { allowed: 4, claimed: 1, desired: 1 },
				udp_alloc: { allowed: 4, claimed: 0, desired: 0 },
			},
		});
		const list = await createPlayitClient('k').listTunnels();
		expect(list.tcp).toEqual({ allowed: 4, claimed: 1 });
		expect(list.tunnels[0]).toMatchObject({
			allocation: { assigned_domain: 'x.joinmc.link', port_start: 1234 },
			local_ip: '10.0.0.2',
			local_port: 25565,
		});
		expect(list.tunnels[1]?.allocation).toBeNull();
	});
});
