/**
 * Visitor-login gateway (issue #99), end to end against a migrated SQLite
 * database and a throwaway origin server: unauthenticated requests never reach
 * the origin, a correct login opens it, our session cookie is not leaked
 * upstream, and credential changes end existing sessions.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOSTNAME = 'secret.example.test';
let tmpDir: string;
let origin: Server;
let gateway: Server;
let gatewayPort: number;
let lastOriginCookie: string | undefined;

function call(
	method: string,
	path: string,
	opts: { cookie?: string; body?: string; accept?: string } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: gatewayPort,
				method,
				path,
				headers: {
					host: HOSTNAME,
					...(opts.cookie ? { cookie: opts.cookie } : {}),
					...(opts.accept ? { accept: opts.accept } : {}),
					...(opts.body
						? {
								'content-type': 'application/x-www-form-urlencoded',
								'content-length': Buffer.byteLength(opts.body),
							}
						: {}),
				},
			},
			(res) => {
				let body = '';
				res.on('data', (c) => {
					body += c;
				});
				res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			}
		);
		req.on('error', reject);
		req.end(opts.body);
	});
}

function sessionFrom(headers: Record<string, string | string[] | undefined>): string {
	const raw = ([] as string[]).concat(headers['set-cookie'] ?? [])[0] ?? '';
	return raw.split(';')[0] ?? '';
}

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-hostgw-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	process.env.CLOUDGATE_INITIAL_ADMIN_PASSWORD = 'unit-test-initial-pw-123456';

	origin = createServer((req, res) => {
		lastOriginCookie = req.headers.cookie;
		res.end(`origin says hi: ${req.url}`);
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	const originPort = (origin.address() as AddressInfo).port;

	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);

	const { getDb } = await import('../src/db/db.js');
	const now = new Date().toISOString();
	const [hostId] = await getDb()('proxy_hosts').insert({
		mode: 'cloudflare_tunnel',
		hostname: HOSTNAME,
		forward_scheme: 'http',
		forward_host: '127.0.0.1',
		forward_port: originPort,
		path_prefix: '/',
		enabled: 1,
		created_at: now,
		updated_at: now,
	});
	const { saveHostAuth } = await import('../src/services/host-auth.js');
	await saveHostAuth(hostId as number, { username: 'alice', password: 'correct horse battery staple' });

	const { startHostGateway } = await import('../src/services/host-gateway.js');
	gateway = startHostGateway(0);
	await new Promise<void>((r) => gateway.once('listening', () => r()));
	gatewayPort = (gateway.address() as AddressInfo).port;
});

afterAll(async () => {
	gateway?.close();
	origin?.close();
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	Reflect.deleteProperty(process.env, 'CLOUDGATE_INITIAL_ADMIN_PASSWORD');
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('host auth gateway', () => {
	it('does not reach the origin without a session', async () => {
		lastOriginCookie = 'untouched';
		const page = await call('GET', '/dash?x=1', { accept: 'text/html' });
		expect(page.status).toBe(302);
		expect(String(page.headers.location)).toContain('/__cg_auth/login?next=%2Fdash%3Fx%3D1');
		const api = await call('GET', '/api/data');
		expect(api.status).toBe(401);
		expect(lastOriginCookie).toBe('untouched');
	});

	it('serves the login page', async () => {
		const res = await call('GET', '/__cg_auth/login');
		expect(res.status).toBe(200);
		expect(res.body).toContain('name="password"');
		expect(res.body).not.toContain('name="totp"');
	});

	it('rejects a wrong password and an unknown user alike', async () => {
		const bad = await call('POST', '/__cg_auth/login', {
			body: 'username=alice&password=nope-nope-nope&next=%2F',
		});
		const unknown = await call('POST', '/__cg_auth/login', {
			body: 'username=bob&password=nope-nope-nope&next=%2F',
		});
		expect(bad.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(bad.headers['set-cookie']).toBeUndefined();
	});

	it('logs in, proxies, and keeps its cookie away from the origin', async () => {
		const login = await call('POST', '/__cg_auth/login', {
			body: 'username=Alice&password=correct%20horse%20battery%20staple&next=%2Fhello',
		});
		expect(login.status).toBe(303);
		expect(login.headers.location).toBe('/hello');
		const cookie = sessionFrom(login.headers);
		expect(cookie).toMatch(/^cg_hostauth=/);

		const res = await call('GET', '/hello', { cookie: `${cookie}; app=1` });
		expect(res.status).toBe(200);
		expect(res.body).toBe('origin says hi: /hello');
		expect(lastOriginCookie).toBe('app=1');
	});

	it('never redirects to an off-site next target', async () => {
		const login = await call('POST', '/__cg_auth/login', {
			body: 'username=alice&password=correct%20horse%20battery%20staple&next=%2F%2Fevil.example',
		});
		expect(login.headers.location).toBe('/');
	});

	it('ends existing sessions when the credentials change', async () => {
		const login = await call('POST', '/__cg_auth/login', {
			body: 'username=alice&password=correct%20horse%20battery%20staple&next=%2F',
		});
		const cookie = sessionFrom(login.headers);
		expect((await call('GET', '/x', { cookie })).status).toBe(200);

		const { getDb } = await import('../src/db/db.js');
		const { saveHostAuth } = await import('../src/services/host-auth.js');
		const row = await getDb()('host_auth').first();
		await new Promise((r) => setTimeout(r, 5));
		await saveHostAuth(row.host_id, { username: 'alice', password: 'a brand new long password' });

		expect((await call('GET', '/x', { cookie })).status).toBe(401);
	});

	it('refuses tab / backslash tricks in next', async () => {
		const pw = 'a%20brand%20new%20long%20password';
		for (const next of ['%2F%09%2Fevil.example', '%2F%5Cevil.example', '%2F%0D%0Ax']) {
			const login = await call('POST', '/__cg_auth/login', {
				body: `username=alice&password=${pw}&next=${next}`,
			});
			expect(login.headers.location).toBe('/');
		}
	});

	it('lets a CORS preflight through without a session but nothing else', async () => {
		const preflight = await new Promise<number>((resolve, reject) => {
			const req = request(
				{
					host: '127.0.0.1',
					port: gatewayPort,
					method: 'OPTIONS',
					path: '/api',
					headers: { host: HOSTNAME, origin: 'https://other.test', 'access-control-request-method': 'POST' },
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				}
			);
			req.on('error', reject);
			req.end();
		});
		expect(preflight).toBe(200);
		expect((await call('POST', '/api', { body: 'x=1' })).status).toBe(401);
	});

	it('answers 404 for a host that has no credentials', async () => {
		const res = await new Promise<number>((resolve, reject) => {
			const req = request(
				{ host: '127.0.0.1', port: gatewayPort, path: '/', headers: { host: 'nope.example.test' } },
				(r) => {
					r.resume();
					resolve(r.statusCode ?? 0);
				}
			);
			req.on('error', reject);
			req.end();
		});
		expect(res).toBe(404);
	});
});

describe('host auth TOTP', () => {
	const pw = 'a%20brand%20new%20long%20password';

	it('requires a fresh code and accepts each code once', async () => {
		const { authenticator } = await import('otplib');
		const { getDb } = await import('../src/db/db.js');
		const { saveHostAuth } = await import('../src/services/host-auth.js');
		const row = await getDb()('host_auth').first();

		const secret = authenticator.generateSecret();
		await saveHostAuth(row.host_id, {
			username: 'alice',
			totp: { secret, code: authenticator.generate(secret) },
		});
		// Setup consumed the current step; rewind so the same step can be used once at login.
		await getDb()('host_auth')
			.where({ host_id: row.host_id })
			.update({ totp_last_step: Math.floor(Date.now() / 30_000) - 2 });

		const page = await call('GET', '/__cg_auth/login');
		expect(page.body).toContain('name="totp"');

		const noCode = await call('POST', '/__cg_auth/login', { body: `username=alice&password=${pw}&next=%2F` });
		expect(noCode.status).toBe(401);

		const code = authenticator.generate(secret);
		const ok = await call('POST', '/__cg_auth/login', {
			body: `username=alice&password=${pw}&totp=${code}&next=%2F`,
		});
		expect(ok.status).toBe(303);

		const replay = await call('POST', '/__cg_auth/login', {
			body: `username=alice&password=${pw}&totp=${code}&next=%2F`,
		});
		expect(replay.status).toBe(401);
	});
});

describe('cloudflared routing for protected hosts', () => {
	it('points a protected host at the gateway instead of its origin', async () => {
		const { getDb } = await import('../src/db/db.js');
		const knex = getDb();
		// No real tunnel needed to render ingress: detach the FK check for this one update.
		await knex.raw('PRAGMA foreign_keys = OFF');
		await knex('proxy_hosts').where({ hostname: HOSTNAME }).update({ tunnel_id: 4242 });
		await knex.raw('PRAGMA foreign_keys = ON');

		const { buildContext, renderConfig } = await import(
			'../src/services/tunnel-providers/cloudflared/config-writer.js'
		);
		const ctx = await buildContext({ id: 4242, tunnel_id: 'abc', credentials_path: '/tmp/x.json' });
		const yaml = await renderConfig(ctx);

		expect(yaml).toContain(`hostname: ${HOSTNAME}`);
		expect(yaml).toMatch(/service: http:\/\/127\.0\.0\.1:8090/);
		expect(yaml).toContain(`httpHostHeader: "${HOSTNAME}"`);
		expect(yaml).not.toContain(`:${(origin.address() as AddressInfo).port}`);
	});
});
