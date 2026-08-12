/**
 * Upstream connectivity probe.
 *
 * After a host deploys, we hit `<scheme>://<host>:<port>/` from inside the
 * container — the same network namespace cloudflared lives in — to verify
 * the user's local service is actually reachable. If the probe finds a
 * common misconfiguration (HTTP scheme against a TLS-only origin, wrong
 * port, self-signed cert without no_tls_verify, ...) we surface a specific
 * diagnostic so the user knows what to fix.
 *
 * This catches the most common Homelab pitfall: pointing CloudGate at
 * Proxmox/TrueNAS/Unifi with `http://` when those services are HTTPS-only
 * on their default port.
 */

import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { childLogger } from '../logger.js';

const log = childLogger('upstream-probe');

export type ProbeOutcome =
	| { kind: 'ok'; statusCode: number; latency_ms: number }
	| { kind: 'tcp_refused'; message: string }
	| { kind: 'tcp_timeout'; message: string }
	| { kind: 'tls_on_http_port'; message: string }
	| { kind: 'http_on_tls_port'; message: string }
	| { kind: 'self_signed_tls'; message: string }
	| { kind: 'http_error'; statusCode: number; message: string }
	/**
	 * The origin answers fine on its own but returns 400 as soon as the
	 * request carries `X-Forwarded-For`. Every request that reaches it
	 * through Cloudflare carries that header, so the site is 100% broken
	 * from the internet while working perfectly on the LAN.
	 */
	| { kind: 'forwarded_header_rejected'; message: string; diagnosis: ForwardedRejectionDiagnosis }
	| { kind: 'unknown'; message: string };

/** Machine-readable payload behind a `forwarded_header_rejected` outcome. */
export interface ForwardedRejectionDiagnosis {
	/** Status the origin returns for a plain request. */
	plain_status: number;
	/** Status the origin returns once `X-Forwarded-For` is added. */
	forwarded_status: number;
	/**
	 * Source IP CloudGate's own traffic leaves from when talking to this
	 * origin. This is the peer address the origin sees, and therefore
	 * exactly what belongs in Home Assistant's `trusted_proxies`.
	 * `null` when it could not be determined.
	 */
	proxy_source_ip: string | null;
	/** `proxy_source_ip` widened to its /24 (IPv4 only) — survives container IP drift. */
	proxy_source_cidr: string | null;
	/** True when the origin looks like Home Assistant. */
	is_home_assistant: boolean;
	/** Ready-to-paste remedy for the detected origin. */
	remedy_yaml: string | null;
}

export interface ProbeArgs {
	scheme: 'http' | 'https';
	host: string;
	port: number;
	no_tls_verify?: boolean;
	timeoutMs?: number;
	/**
	 * Public hostname this origin is published under. Optional — when given
	 * we send it as the Host header so vhost-matching origins behave the
	 * same way they will in production.
	 */
	hostname?: string;
}

/**
 * Step 1: TCP-probe to check the port is listening at all.
 * Step 2: Look at the first byte to figure out whether the listener is
 *         actually HTTP or TLS. TLS handshakes start with 0x16; HTTP
 *         responses start with a printable ASCII byte.
 * Step 3: For HTTPS configs, validate the TLS cert (unless no_tls_verify).
 * Step 4: Issue a HEAD/GET against / and capture the status.
 */
export async function probeUpstream(args: ProbeArgs): Promise<ProbeOutcome> {
	const timeoutMs = args.timeoutMs ?? 4000;
	const sniffed = await sniffPort(args.host, args.port, timeoutMs);
	if (sniffed.kind === 'refused') {
		return {
			kind: 'tcp_refused',
			message: `Connection to ${args.host}:${args.port} refused — service down, wrong IP/port, or firewall blocking.`,
		};
	}
	if (sniffed.kind === 'timeout') {
		return {
			kind: 'tcp_timeout',
			message: `Connection to ${args.host}:${args.port} timed out — host unreachable from the CloudGate container.`,
		};
	}

	// We got bytes back. Classify the listener.
	const firstByte = sniffed.firstByte;
	const looksLikeTls = firstByte === 0x16; // TLS ContentType.handshake

	if (args.scheme === 'http' && looksLikeTls) {
		return {
			kind: 'tls_on_http_port',
			message: `The service at ${args.host}:${args.port} speaks TLS but the host is configured with scheme "http". Edit the host, switch to https + tick "Don't verify upstream TLS certificate".`,
		};
	}
	if (args.scheme === 'https' && !looksLikeTls && firstByte !== undefined) {
		return {
			kind: 'http_on_tls_port',
			message: `The service at ${args.host}:${args.port} speaks plain HTTP but the host is configured with scheme "https". Edit the host and switch to http.`,
		};
	}

	// Before the generic status check: does this origin reject *proxied*
	// requests? That failure is invisible to a plain probe — the origin
	// answers 200 to us and 400 to everything arriving through Cloudflare.
	// Checking it first means we report the cause instead of the symptom.
	try {
		const forwarded = await probeForwardedHeaders(args);
		if (forwarded) {
			return {
				kind: 'forwarded_header_rejected',
				message: formatForwardedRejection(args, forwarded),
				diagnosis: forwarded,
			};
		}
	} catch (err) {
		// Diagnostics must never break a deploy — fall through to the
		// generic probe and let that report whatever it finds.
		log.debug({ err: (err as Error).message }, 'forwarded-header probe failed');
	}

	// Try a real HTTP(S) request now that we know the wire-level matches.
	try {
		const url = `${args.scheme}://${args.host}:${args.port}/`;
		const start = Date.now();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(url, {
			method: 'GET',
			signal: ctrl.signal,
			// Self-signed certs would fail without no_tls_verify — but Node's
			// global undici client honours NODE_TLS_REJECT_UNAUTHORIZED=0
			// for self-signed, and per-call options are limited. We rely on
			// the wire-level sniff above for the most common diagnostic.
		}).catch((err) => err);
		clearTimeout(timer);
		if (res instanceof Error) {
			const msg = res.message;
			if (msg.includes('self-signed') || msg.includes('SELF_SIGNED')) {
				return {
					kind: 'self_signed_tls',
					message: `The upstream uses a self-signed TLS cert. Edit the host and tick "Don't verify upstream TLS certificate".`,
				};
			}
			return { kind: 'unknown', message: `Probe failed: ${msg}` };
		}
		const status = res.status;
		const latency = Date.now() - start;
		if (status >= 200 && status < 500) {
			return { kind: 'ok', statusCode: status, latency_ms: latency };
		}
		return {
			kind: 'http_error',
			statusCode: status,
			message: `Upstream replied ${status} — service is reachable but returned an error.`,
		};
	} catch (err) {
		return { kind: 'unknown', message: `Probe error: ${(err as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// Forwarded-header rejection probe
//
// Why this exists
// ---------------
// Cloudflare's edge ALWAYS adds `X-Forwarded-For` (and `X-Forwarded-Proto`)
// to requests before they enter the tunnel, and cloudflared passes them to
// the origin untouched. Home Assistant's forwarded_middleware
// (homeassistant/components/http/forwarded.py) raises HTTPBadRequest — a
// bare 400 — when it sees `X-Forwarded-For` and either
//
//   a) `use_x_forwarded_for` is not enabled (the default), or
//   b) the TCP peer is not listed in `trusted_proxies`.
//
// The result is the single most confusing failure a homelab user can hit:
// the service is up, the tunnel is healthy, DNS resolves, the LAN works —
// and every request from the internet gets 400. A plain status-code probe
// reports "upstream returned 400" and blames the wrong layer, so we probe
// twice and compare.
// ---------------------------------------------------------------------------

/** Documentation-range IP (RFC 5737) — never a real client, safe to send. */
const PROBE_CLIENT_IP = '203.0.113.7';

export interface ForwardedProbeArgs extends ProbeArgs {
	/** Public hostname, used for the Host header so vhost-matching origins reply normally. */
	hostname?: string;
}

/**
 * Compare the origin's response with and without `X-Forwarded-*`.
 *
 * Returns `null` when the comparison is inconclusive (origin unreachable,
 * both requests failed, …) so callers can fall back to the generic probe.
 */
export async function probeForwardedHeaders(
	args: ForwardedProbeArgs
): Promise<ForwardedRejectionDiagnosis | null> {
	const timeoutMs = args.timeoutMs ?? 4000;
	const base = {
		scheme: args.scheme,
		host: args.host,
		port: args.port,
		no_tls_verify: args.no_tls_verify,
		timeoutMs,
		hostHeader: args.hostname,
	};

	const plain = await rawRequest({ ...base, path: '/' });
	if (!plain.ok) return null;

	const forwarded = await rawRequest({
		...base,
		path: '/',
		headers: {
			'X-Forwarded-For': PROBE_CLIENT_IP,
			'X-Forwarded-Proto': 'https',
			...(args.hostname ? { 'X-Forwarded-Host': args.hostname } : {}),
		},
	});
	if (!forwarded.ok) return null;

	// Only the transition *into* 400 is diagnostic. An origin that 400s both
	// ways has a different problem entirely, and claiming a forwarded-header
	// issue there would send the user down the wrong path.
	//
	// The plain response is allowed to be any non-400 status: an origin that
	// answers 401 or 302 on `/` (auth-gated services) and 400 once the header
	// is present has exactly the same bug as one that answers 200.
	if (plain.statusCode === 400 || forwarded.statusCode !== 400) return null;

	const proxySourceIp = plain.localAddress ?? forwarded.localAddress ?? null;
	const isHa = await looksLikeHomeAssistant(base);

	return {
		plain_status: plain.statusCode,
		forwarded_status: forwarded.statusCode,
		proxy_source_ip: proxySourceIp,
		proxy_source_cidr: toSlash24(proxySourceIp),
		is_home_assistant: isHa,
		remedy_yaml: isHa ? buildHomeAssistantRemedy(proxySourceIp) : null,
	};
}

/**
 * The `http:` block a user must add to Home Assistant's configuration.yaml.
 *
 * We recommend the /24 rather than the bare address: CloudGate's container
 * IP changes whenever Docker re-creates the container, and a pinned single
 * IP silently breaks again on the next `docker compose up`. This is the
 * single most-reported follow-up failure in the HA community threads.
 */
export function buildHomeAssistantRemedy(proxySourceIp: string | null): string {
	const cidr = toSlash24(proxySourceIp);
	const entry = cidr ?? '172.16.0.0/12';
	const comment = cidr
		? `# CloudGate reaches Home Assistant from ${proxySourceIp} —`
		: "# Could not detect CloudGate's source IP; this covers the usual Docker bridge ranges —";
	return [
		'http:',
		'  use_x_forwarded_for: true',
		'  trusted_proxies:',
		`    ${comment}`,
		'    # the /24 keeps working after the container gets a new IP.',
		`    - ${entry}`,
	].join('\n');
}

/**
 * Human-readable diagnosis. This string lands in `proxy_hosts.last_error`
 * and is the only thing most users will read, so it names the cause, the
 * fix, and where to apply it — in that order.
 */
export function formatForwardedRejection(args: ProbeArgs, d: ForwardedRejectionDiagnosis): string {
	const target = `${args.host}:${args.port}`;
	const lines: string[] = [];

	if (d.is_home_assistant) {
		lines.push(
			`Home Assistant at ${target} is rejecting proxied requests with 400 Bad Request.`,
			'',
			`It answers ${d.plain_status} to a direct request but 400 as soon as the request carries an X-Forwarded-For header. Cloudflare adds that header to every request, so Home Assistant is unreachable through the tunnel while working fine on your LAN.`,
			'',
			'Fix it in Home Assistant — add this to configuration.yaml and restart HA:',
			'',
			d.remedy_yaml ?? '',
			'',
			'CloudGate cannot set this for you: Cloudflare adds X-Forwarded-For at its edge, before the tunnel, and cloudflared has no option to remove it.'
		);
	} else {
		lines.push(
			`The service at ${target} rejects proxied requests with 400 Bad Request.`,
			'',
			`It answers ${d.plain_status} to a direct request but 400 once an X-Forwarded-For header is present. Cloudflare adds that header to every request, so the service is unreachable through the tunnel.`,
			'',
			'Configure the service to trust its reverse proxy.'
		);
		if (d.proxy_source_ip) {
			lines.push(
				`CloudGate reaches it from ${d.proxy_source_ip}${
					d.proxy_source_cidr ? ` (allow ${d.proxy_source_cidr} so it survives container restarts)` : ''
				}.`
			);
		}
	}

	lines.push('', 'Details: docs/HOME-ASSISTANT.md');
	return lines.join('\n');
}

/** Widen an IPv4 address to its /24. IPv6 and unparseable input yield null. */
function toSlash24(ip: string | null): string | null {
	if (!ip) return null;
	// Node reports IPv4-mapped IPv6 peers as ::ffff:172.18.0.5
	const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	const parts = v4.split('.');
	if (parts.length !== 4) return null;
	if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
	return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * Home Assistant serves an unauthenticated `/manifest.json` naming itself.
 * Used only to tailor the remedy text — a false negative just means the
 * user gets the generic message.
 */
async function looksLikeHomeAssistant(base: RawRequestArgs): Promise<boolean> {
	const res = await rawRequest({ ...base, path: '/manifest.json' });
	if (!res.ok || res.statusCode !== 200) return false;
	return /home\s*assistant/i.test(res.body);
}

// ---------------------------------------------------------------------------
// Minimal HTTP client
//
// We can't use fetch(): we need per-request TLS verification control (for
// self-signed origins) and the local socket address, neither of which undici
// exposes. node:http/https gives us both.
// ---------------------------------------------------------------------------

interface RawRequestArgs {
	scheme: 'http' | 'https';
	host: string;
	port: number;
	path?: string;
	no_tls_verify?: boolean;
	timeoutMs: number;
	hostHeader?: string;
	headers?: Record<string, string>;
}

type RawResponse =
	| { ok: true; statusCode: number; body: string; localAddress: string | null }
	| { ok: false; error: string };

async function rawRequest(args: RawRequestArgs): Promise<RawResponse> {
	const mod = args.scheme === 'https' ? await import('node:https') : await import('node:http');
	return new Promise<RawResponse>((resolve) => {
		let settled = false;
		const finish = (r: RawResponse): void => {
			if (settled) return;
			settled = true;
			resolve(r);
		};

		let localAddress: string | null = null;
		const req = mod.request(
			{
				host: args.host,
				port: args.port,
				path: args.path ?? '/',
				method: 'GET',
				headers: {
					// A browser-ish UA avoids origins that special-case unknown clients.
					'User-Agent': 'CloudGate-Diagnostics/1.0',
					...(args.hostHeader ? { Host: args.hostHeader } : {}),
					...(args.headers ?? {}),
				},
				timeout: args.timeoutMs,
				...(args.scheme === 'https'
					? { rejectUnauthorized: !args.no_tls_verify, servername: args.hostHeader ?? args.host }
					: {}),
			},
			(res) => {
				// Cap the body — we only ever need a marker string, and an
				// origin streaming megabytes must not blow up the container.
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					if (body.length < 16384) body += chunk;
				});
				res.on('end', () => finish({ ok: true, statusCode: res.statusCode ?? 0, body, localAddress }));
				res.on('error', (err: Error) => finish({ ok: false, error: err.message }));
			}
		);

		req.on('socket', (sock) => {
			const capture = (): void => {
				localAddress = sock.localAddress ?? null;
			};
			if (sock.localAddress) capture();
			else sock.once('connect', capture);
		});
		req.on('timeout', () => {
			req.destroy();
			finish({ ok: false, error: 'timeout' });
		});
		req.on('error', (err: Error) => finish({ ok: false, error: err.message }));
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Low-level TCP sniff
// ---------------------------------------------------------------------------

type SniffResult =
	| { kind: 'refused' }
	| { kind: 'timeout' }
	| { kind: 'open'; firstByte: number | undefined };

async function sniffPort(host: string, port: number, timeoutMs: number): Promise<SniffResult> {
	return new Promise<SniffResult>((resolve) => {
		const sock = connect({ host, port });
		let done = false;
		const finish = (r: SniffResult): void => {
			if (done) return;
			done = true;
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(r);
		};

		const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
		sock.once('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			log.debug({ host, port, err: err.message, code: err.code }, 'sniff: socket error');
			finish({ kind: 'refused' });
		});
		sock.once('connect', () => {
			// Most servers wait for us to speak first (HTTP), but TLS servers
			// also wait. We send a probe request — for HTTP this gets a real
			// response, for TLS this gets a handshake alert (starts with 0x16
			// in fact if we send anything wrong).
			//
			// Simpler: send a TLS ClientHello-shaped probe? No. We send a
			// short HTTP-looking line, then look at first response byte:
			//   - HTTP server -> "HTTP/" (0x48)
			//   - TLS server  -> 0x15 (alert) or 0x16 (handshake), in either
			//                    case high-bit-not-ASCII
			sock.write('HEAD / HTTP/1.0\r\n\r\n');
			sock.once('data', (buf: Buffer) => {
				clearTimeout(timer);
				finish({ kind: 'open', firstByte: buf[0] });
			});
		});
	});
}

/** For unit tests + future TLS-detail diagnostics. */
export async function tlsPeerCertSummary(
	host: string,
	port: number
): Promise<{ subject: string; selfSigned: boolean } | null> {
	return new Promise((resolve) => {
		const sock = tlsConnect({ host, port, rejectUnauthorized: false, servername: host }, () => {
			const cert = sock.getPeerCertificate();
			const subject =
				typeof cert.subject === 'object' ? JSON.stringify(cert.subject) : String(cert.subject ?? '');
			const selfSigned = !cert.issuer || JSON.stringify(cert.issuer) === JSON.stringify(cert.subject);
			sock.end();
			resolve({ subject, selfSigned });
		});
		sock.on('error', () => resolve(null));
		setTimeout(() => {
			sock.destroy();
			resolve(null);
		}, 3000).unref();
	});
}
