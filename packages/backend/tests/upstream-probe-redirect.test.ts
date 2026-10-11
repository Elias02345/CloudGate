/**
 * Regression for #87: an origin that redirects forever unless the session
 * cookie comes back (PHPSESSID apps) must probe as reachable, not as
 * "fetch failed".
 */

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { probeUpstream } from '../src/services/upstream-probe.js';

let server: Server | undefined;

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

it('treats a cookie-gated redirect loop as reachable', async () => {
	server = createServer((req, res) => {
		const target = req.url === '/' ? '/login' : '/';
		res.writeHead(302, { Location: target, 'Set-Cookie': 'PHPSESSID=new' });
		res.end();
	});
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;

	const out = await probeUpstream({ scheme: 'http', host: '127.0.0.1', port });
	expect(out.kind).toBe('ok');
});
