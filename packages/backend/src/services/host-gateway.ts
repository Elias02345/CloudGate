/**
 * Auth gateway for protected hosts (issue #99).
 *
 * cloudflared sends a host that has credentials configured here instead of
 * straight to its origin (see tunnel-providers/cloudflared/config-writer.ts).
 * The gateway shows a login page, and only after a valid session cookie does
 * it forward the request — including WebSocket upgrades — to the real origin.
 *
 * It binds to 127.0.0.1 only: the single client is the cloudflared process in
 * this container. If the gateway is down cloudflared answers 502, so a
 * protected host fails closed.
 */

import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import {
	HOST_SESSION_COOKIE,
	HOST_SESSION_TTL_SECONDS,
	type HostAuthRow,
	checkHostLogin,
	issueHostSession,
	verifyHostSession,
} from './host-auth.js';

const log = childLogger('host-gateway');

export const DEFAULT_GATEWAY_PORT = 8090;
export function gatewayPort(): number {
	const n = Number.parseInt(process.env.CLOUDGATE_GATEWAY_PORT ?? '', 10);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_GATEWAY_PORT;
}

const AUTH_PREFIX = '/__cg_auth';
const MAX_FORM_BYTES = 4096;

interface HostRow {
	id: number;
	hostname: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	tls_options: string | null;
	advanced_options: string | null;
}

interface Target {
	host: HostRow;
	auth: HostAuthRow;
	noTlsVerify: boolean;
	hostHeader: string | undefined;
	serverName: string | undefined;
}

function parseJson<T>(raw: string | null): Partial<T> {
	try {
		return raw ? (JSON.parse(raw) as T) : {};
	} catch {
		return {};
	}
}

async function lookup(hostHeader: string | undefined): Promise<Target | null> {
	const name = (hostHeader ?? '').split(':')[0]?.trim().toLowerCase();
	if (!name) return null;
	const knex = getDb();
	const host = await knex<HostRow>('proxy_hosts')
		.whereRaw('lower(hostname) = ?', [name])
		.andWhere({ enabled: 1, mode: 'cloudflare_tunnel' })
		.first();
	if (!host) return null;
	const auth = await knex<HostAuthRow>('host_auth').where({ host_id: host.id }).first();
	if (!auth) return null;
	const tls = parseJson<{ no_tls_verify?: boolean }>(host.tls_options);
	const adv = parseJson<{ http_host_header?: string; origin_server_name?: string }>(host.advanced_options);
	return {
		host,
		auth,
		noTlsVerify: Boolean(tls.no_tls_verify),
		hostHeader: adv.http_host_header,
		serverName: adv.origin_server_name,
	};
}

// ---------------------------------------------------------------------------
// Login throttling (in memory — a restart resets it, which is acceptable)
// ---------------------------------------------------------------------------
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10_000;
const fails = new Map<string, { count: number; resetAt: number }>();

function throttled(key: string, limit: number): boolean {
	const e = fails.get(key);
	return !!e && e.resetAt > Date.now() && e.count >= limit;
}
function noteFailure(key: string): void {
	const now = Date.now();
	const e = fails.get(key);
	if (!e || e.resetAt <= now) {
		// Bounded: Map iterates in insertion order, so drop the oldest entries.
		for (const k of fails.keys()) {
			if (fails.size < MAX_TRACKED) break;
			fails.delete(k);
		}
		fails.set(key, { count: 1, resetAt: now + WINDOW_MS });
	} else e.count += 1;
}
const sweeper = setInterval(() => {
	const now = Date.now();
	for (const [k, v] of fails) if (v.resetAt <= now) fails.delete(k);
}, 60_000);
sweeper.unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clientIp(req: IncomingMessage): string {
	// Only cloudflared can reach this listener (127.0.0.1), so its header is trustworthy.
	const cf = req.headers['cf-connecting-ip'];
	if (typeof cf === 'string' && cf) return cf;
	return req.socket.remoteAddress ?? 'unknown';
}

function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const i = part.indexOf('=');
		if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return null;
}

function stripOurCookie(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const kept = header
		.split(';')
		.map((p) => p.trim())
		.filter((p) => p && !p.startsWith(`${HOST_SESSION_COOKIE}=`));
	return kept.length ? kept.join('; ') : undefined;
}

/** Same-site relative paths only — never an absolute or protocol-relative URL. */
function safeNext(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith(AUTH_PREFIX)) return '/';
	// Browsers drop tabs/newlines and treat '\' as '/', so "/\t/evil.example"
	// becomes "//evil.example". Refuse control characters and backslashes
	// outright, then confirm the URL parser keeps us on the same origin.
	if (Array.from(value).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || c === '\\'))
		return '/';
	try {
		const u = new URL(value, 'http://gateway.local');
		if (u.origin !== 'http://gateway.local') return '/';
	} catch {
		return '/';
	}
	return value;
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
	const secure = req.headers['x-forwarded-proto'] === 'http' ? '' : '; Secure';
	return `${HOST_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function loginPage(opts: {
	hostname: string;
	next: string;
	needTotp: boolean;
	error?: string;
	username?: string;
}): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#1a1d23;--mute:#6b7280;--line:#d6dae1;--acc:#2563eb;--err:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1d2026;--fg:#e6e8ec;--mute:#9aa1ad;--line:#343944;--acc:#5b8def;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{margin:0 0 4px;font-size:1.25rem}p{margin:0 0 16px;color:var(--mute);font-size:.9rem;overflow-wrap:anywhere}
label{display:block;margin:12px 0 4px;font-size:.85rem}input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{margin:12px 0 0;color:var(--err);font-size:.9rem}
</style></head><body><main>
<h1>Sign in</h1><p>${esc(opts.hostname)}</p>
<form method="post" action="${AUTH_PREFIX}/login">
<input type="hidden" name="next" value="${esc(opts.next)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus value="${esc(opts.username ?? '')}">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
${opts.needTotp ? '<label for="t">Authentication code</label><input id="t" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>' : ''}
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ''}
<button type="submit">Sign in</button></form></main></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy':
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	});
	res.end(html);
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
	return new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > MAX_FORM_BYTES) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
		req.on('error', () => resolve(null));
	});
}

async function isAuthenticated(req: IncomingMessage, t: Target): Promise<boolean> {
	const token = readCookie(req.headers.cookie, HOST_SESSION_COOKIE);
	return token ? verifyHostSession(token, t.auth) : false;
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
async function handleAuthPath(req: IncomingMessage, res: ServerResponse, t: Target, url: URL): Promise<void> {
	const hostname = t.host.hostname;

	if (url.pathname === `${AUTH_PREFIX}/logout`) {
		res.writeHead(302, {
			Location: `${AUTH_PREFIX}/login`,
			'Set-Cookie': sessionCookie(req, '', 0),
			'Cache-Control': 'no-store',
		});
		res.end();
		return;
	}

	if (url.pathname !== `${AUTH_PREFIX}/login`) {
		res.writeHead(404).end();
		return;
	}

	if (req.method === 'GET' || req.method === 'HEAD') {
		sendHtml(
			res,
			200,
			loginPage({
				hostname,
				next: safeNext(url.searchParams.get('next')),
				needTotp: Boolean(t.auth.totp_enabled),
			})
		);
		return;
	}
	if (req.method !== 'POST') {
		res.writeHead(405, { Allow: 'GET, POST' }).end();
		return;
	}

	const form = await readForm(req);
	if (!form) {
		res.writeHead(413).end();
		return;
	}
	const next = safeNext(form.get('next'));
	const username = (form.get('username') ?? '').slice(0, 64);
	const ip = clientIp(req);
	const perIp = `${t.host.id}|${ip}`;
	const perHost = `${t.host.id}|*`;
	const page = (error: string, needTotp = Boolean(t.auth.totp_enabled), status = 401): void =>
		sendHtml(res, status, loginPage({ hostname, next, needTotp, error, username }));

	if (throttled(perIp, 10) || throttled(perHost, 60)) {
		res.setHeader('Retry-After', '900');
		page('Too many attempts. Try again in a few minutes.', Boolean(t.auth.totp_enabled), 429);
		return;
	}

	const result = await checkHostLogin(
		t.auth,
		username,
		(form.get('password') ?? '').slice(0, 256),
		(form.get('totp') ?? '').trim() || undefined
	);
	if (result !== 'ok') {
		noteFailure(perIp);
		noteFailure(perHost);
		log.info({ host: hostname, ip, result }, 'host login failed');
		page(result === 'totp_invalid' ? 'Invalid or already used code.' : 'Wrong username or password.');
		return;
	}

	const token = await issueHostSession(t.auth);
	log.info({ host: hostname, ip }, 'host login ok');
	res.writeHead(303, {
		Location: next,
		'Set-Cookie': sessionCookie(req, token, HOST_SESSION_TTL_SECONDS),
		'Cache-Control': 'no-store',
	});
	res.end();
}

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

/**
 * SNI for the origin: the explicit override, else the connect host — but never
 * an IP literal or a "host:port" string, which are not valid SNI values.
 */
function sniFor(t: Target, rawHost: string): string | undefined {
	const name = t.serverName ?? rawHost;
	return isIP(name) || name.includes(':') ? undefined : name;
}

function upstreamOptions(
	req: IncomingMessage,
	t: Target,
	upgrade: boolean
): http.RequestOptions & https.RequestOptions {
	const headers: IncomingHttpHeaders = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if ((!upgrade && HOP_BY_HOP.has(k)) || k === 'cookie') continue;
		headers[k] = v;
	}
	// Our session cookie is the gateway's business, not the origin's.
	const cookie = stripOurCookie(req.headers.cookie);
	if (cookie) headers.cookie = cookie;
	if (t.hostHeader) headers.host = t.hostHeader;
	headers['x-forwarded-for'] = clientIp(req);
	headers['x-forwarded-proto'] = 'https';
	headers['x-forwarded-host'] = t.host.hostname;

	const isHttps = t.host.forward_scheme === 'https';
	const rawHost = t.host.forward_host.replace(/^\[|\]$/g, '');
	return {
		host: rawHost,
		port: t.host.forward_port,
		method: req.method,
		path: req.url,
		headers,
		...(isHttps ? { rejectUnauthorized: !t.noTlsVerify, servername: sniFor(t, rawHost) } : {}),
	};
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, t: Target): void {
	const lib = t.host.forward_scheme === 'https' ? https : http;
	const up = lib.request(upstreamOptions(req, t, false), (upRes) => {
		const out: IncomingHttpHeaders = {};
		for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
		res.writeHead(upRes.statusCode ?? 502, out as http.OutgoingHttpHeaders);
		upRes.pipe(res);
	});
	up.on('error', (err) => {
		log.warn({ host: t.host.hostname, err: err.message }, 'origin unreachable');
		if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end('Bad gateway');
	});
	req.pipe(up);
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, t: Target): void {
	const lib = t.host.forward_scheme === 'https' ? https : http;
	const up = lib.request(upstreamOptions(req, t, true));
	up.on('upgrade', (upRes, upSocket, upHead) => {
		const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ''}`];
		for (let i = 0; i < upRes.rawHeaders.length; i += 2)
			lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
		socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (upHead.length) socket.write(upHead);
		if (head.length) upSocket.write(head);
		upSocket.pipe(socket).pipe(upSocket);
		upSocket.on('error', () => socket.destroy());
		socket.on('error', () => upSocket.destroy());
	});
	up.on('response', (r) => {
		// Origin declined the upgrade — relay its answer, then close.
		socket.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
	});
	up.on('error', () => socket.destroy());
	up.end();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const t = await lookup(req.headers.host);
	if (!t) {
		res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
		return;
	}
	const url = new URL(req.url ?? '/', 'http://gateway.local');
	if (url.pathname === AUTH_PREFIX || url.pathname.startsWith(`${AUTH_PREFIX}/`)) {
		await handleAuthPath(req, res, t, url);
		return;
	}
	// A CORS preflight never carries cookies, so it can only be answered by the
	// origin or not at all; letting it through exposes nothing (no body, no
	// credentials) and keeps cross-origin calls between protected apps working.
	const isPreflight =
		req.method === 'OPTIONS' &&
		typeof req.headers.origin === 'string' &&
		typeof req.headers['access-control-request-method'] === 'string';
	if (isPreflight || (await isAuthenticated(req, t))) {
		proxyHttp(req, res, t);
		return;
	}
	const wantsPage =
		(req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html');
	if (wantsPage) {
		res.writeHead(302, {
			Location: `${AUTH_PREFIX}/login?next=${encodeURIComponent(safeNext(req.url))}`,
			'Cache-Control': 'no-store',
		});
		res.end();
		return;
	}
	res
		.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
		.end('Authentication required');
}

export function startHostGateway(port: number = gatewayPort()): http.Server {
	const server = createServer((req, res) => {
		onRequest(req, res).catch((err) => {
			log.error({ err: (err as Error).message }, 'gateway request failed');
			if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('Internal error');
		});
	});
	server.on('upgrade', (req, socket, head) => {
		void (async () => {
			const t = await lookup(req.headers.host);
			if (!t || !(await isAuthenticated(req, t))) {
				socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
				return;
			}
			proxyUpgrade(req, socket, head, t);
		})().catch(() => socket.destroy());
	});
	server.on('error', (err) =>
		log.warn({ err: err.message }, 'host gateway could not start — protected hosts will answer 502')
	);
	server.listen(port, '127.0.0.1', () => log.info({ port }, 'host auth gateway listening'));
	return server;
}
