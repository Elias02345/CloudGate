/**
 * Forwarded-header rejection probe.
 *
 * Reproduces the exact failure that makes Home Assistant unreachable behind
 * a Cloudflare Tunnel: HA's forwarded_middleware raises HTTPBadRequest when a
 * request carries `X-Forwarded-For` and `use_x_forwarded_for`/`trusted_proxies`
 * are not configured. Cloudflare's edge adds that header to every request, so
 * the origin answers 200 on the LAN and 400 to the entire internet.
 *
 * The fake origins below mimic that behaviour so the diagnostic can be tested
 * without a Home Assistant instance.
 */

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
	buildHomeAssistantRemedy,
	probeForwardedHeaders,
	probeUpstream,
} from '../src/services/upstream-probe.js';

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

interface FakeOriginOptions {
	/** Reject requests carrying X-Forwarded-For with 400, the way HA does. */
	rejectForwarded: boolean;
	/** Serve an HA-shaped /manifest.json. */
	homeAssistant?: boolean;
	/** Status returned when nothing else applies. */
	plainStatus?: number;
}

async function startFakeOrigin(opts: FakeOriginOptions): Promise<number> {
	const server = createServer((req, res) => {
		if (opts.rejectForwarded && req.headers['x-forwarded-for']) {
			// aiohttp's HTTPBadRequest: bare 400, plain-text body.
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			res.end('400: Bad Request');
			return;
		}
		if (req.url === '/manifest.json') {
			if (!opts.homeAssistant) {
				res.writeHead(404).end('not found');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ name: 'Home Assistant', short_name: 'Home Assistant' }));
			return;
		}
		res.writeHead(opts.plainStatus ?? 200, { 'Content-Type': 'text/html' });
		res.end('<html><body>ok</body></html>');
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as AddressInfo).port;
}

describe('probeForwardedHeaders', () => {
	it('detects an origin that answers fine directly but 400s on X-Forwarded-For', async () => {
		const port = await startFakeOrigin({ rejectForwarded: true, homeAssistant: true });
		const d = await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port });

		expect(d).not.toBeNull();
		expect(d?.plain_status).toBe(200);
		expect(d?.forwarded_status).toBe(400);
		expect(d?.is_home_assistant).toBe(true);
		// The address the origin sees as its peer — what goes in trusted_proxies.
		expect(d?.proxy_source_ip).toBe('127.0.0.1');
		expect(d?.proxy_source_cidr).toBe('127.0.0.0/24');
		expect(d?.remedy_yaml).toContain('use_x_forwarded_for: true');
		expect(d?.remedy_yaml).toContain('127.0.0.0/24');
	});

	it('recognises a non-Home-Assistant origin with the same behaviour', async () => {
		const port = await startFakeOrigin({ rejectForwarded: true, homeAssistant: false });
		const d = await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port });

		expect(d).not.toBeNull();
		expect(d?.is_home_assistant).toBe(false);
		// No HA-specific YAML for something that isn't HA.
		expect(d?.remedy_yaml).toBeNull();
	});

	it('stays silent for a healthy origin', async () => {
		const port = await startFakeOrigin({ rejectForwarded: false, homeAssistant: true });
		expect(await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port })).toBeNull();
	});

	it('stays silent when the origin 400s regardless of headers', async () => {
		// A permanently-broken origin is a different problem; claiming a
		// forwarded-header issue here would send the user down the wrong path.
		const port = await startFakeOrigin({ rejectForwarded: true, plainStatus: 400 });
		expect(await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port })).toBeNull();
	});

	it('still fires for an auth-gated origin that answers 401 directly', async () => {
		// Services that redirect or challenge on `/` have the same bug; the
		// signal is the transition into 400, not the plain status being 200.
		const port = await startFakeOrigin({ rejectForwarded: true, plainStatus: 401 });
		const d = await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port });
		expect(d).not.toBeNull();
		expect(d?.plain_status).toBe(401);
		expect(d?.forwarded_status).toBe(400);
	});

	it('stays silent when the origin is unreachable', async () => {
		const port = await startFakeOrigin({ rejectForwarded: true });
		await new Promise<void>((resolve) => servers.splice(0)[0].close(() => resolve()));
		expect(
			await probeForwardedHeaders({ scheme: 'http', host: '127.0.0.1', port, timeoutMs: 1000 })
		).toBeNull();
	});
});

describe('probeUpstream integration', () => {
	it('reports the cause, not the 400 symptom', async () => {
		const port = await startFakeOrigin({ rejectForwarded: true, homeAssistant: true });
		const outcome = await probeUpstream({
			scheme: 'http',
			host: '127.0.0.1',
			port,
			hostname: 'ha.example.com',
		});

		expect(outcome.kind).toBe('forwarded_header_rejected');
		if (outcome.kind !== 'forwarded_header_rejected') throw new Error('unreachable');
		// The message is what lands in last_error and is all most users read:
		// it has to carry the remedy, not just the diagnosis.
		expect(outcome.message).toContain('Home Assistant');
		expect(outcome.message).toContain('use_x_forwarded_for: true');
		expect(outcome.message).toContain('trusted_proxies');
		expect(outcome.diagnosis.is_home_assistant).toBe(true);
	});

	it('still reports plain reachability for a healthy origin', async () => {
		const port = await startFakeOrigin({ rejectForwarded: false });
		const outcome = await probeUpstream({ scheme: 'http', host: '127.0.0.1', port });
		expect(outcome.kind).toBe('ok');
	});
});

describe('buildHomeAssistantRemedy', () => {
	it('recommends the /24, not the pinned container IP', async () => {
		// Pinning a single container IP is the most common way this fix
		// silently breaks again after `docker compose up` re-creates the
		// container with a new address.
		const yaml = buildHomeAssistantRemedy('172.18.0.5');
		expect(yaml).toContain('- 172.18.0.0/24');
		expect(yaml).not.toContain('- 172.18.0.5\n');
	});

	it('falls back to the private Docker range when the IP is unknown', async () => {
		expect(buildHomeAssistantRemedy(null)).toContain('- 172.16.0.0/12');
	});

	it('handles IPv4-mapped IPv6 peers', async () => {
		expect(buildHomeAssistantRemedy('::ffff:172.18.0.5')).toContain('- 172.18.0.0/24');
	});
});
