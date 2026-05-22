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
	| { kind: 'unknown'; message: string };

export interface ProbeArgs {
	scheme: 'http' | 'https';
	host: string;
	port: number;
	no_tls_verify?: boolean;
	timeoutMs?: number;
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
export async function tlsPeerCertSummary(host: string, port: number): Promise<{ subject: string; selfSigned: boolean } | null> {
	return new Promise((resolve) => {
		const sock = tlsConnect({ host, port, rejectUnauthorized: false, servername: host }, () => {
			const cert = sock.getPeerCertificate();
			const subject = typeof cert.subject === 'object' ? JSON.stringify(cert.subject) : String(cert.subject ?? '');
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
