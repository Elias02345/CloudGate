/**
 * "Is this request coming from the local network?" — used to gate the
 * unauthenticated first-run setup endpoint (POST /api/setup) alongside the
 * time window in setup-window.ts.
 *
 * This is defence in depth, not a guarantee. The primary control is the
 * setup window: it closes N minutes after process start regardless of what
 * a client claims about itself. A reverse proxy, VPN, or tunnel daemon
 * sitting on the LAN can still make internet traffic look local to us — the
 * CF-Connecting-IP / X-Forwarded-For checks below only catch the obvious
 * cases (a Cloudflare-fronted request, or one that has visibly traversed a
 * public hop), not a determined attacker who controls the network path.
 *
 * Pure + synchronous so it is trivial to unit test.
 */

import { BlockList, isIP } from 'node:net';

// ponytail: node:net's BlockList does the CIDR math (and matches IPv4-mapped
// IPv6 against the IPv4 rules), so no hand-rolled address parsing here.
const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT / Tailscale
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
PRIVATE.addAddress('::1', 'ipv6'); // loopback
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique local
PRIVATE.addSubnet('fe80::', 10, 'ipv6'); // link-local

/**
 * True for loopback, RFC1918, CGNAT (100.64/10, used by Tailscale), and
 * link-local ranges in both IPv4 and IPv6 (including IPv6 ULA and
 * IPv4-mapped IPv6 like `::ffff:10.0.0.5`).
 */
export function isPrivateIp(ip: string | undefined | null): boolean {
	if (!ip) return false;
	const clean = ip
		.trim()
		.replace(/^\[|\]$/g, '')
		.replace(/%.*$/, '');
	const family = isIP(clean);
	if (family === 0) return false;
	return PRIVATE.check(clean, family === 4 ? 'ipv4' : 'ipv6');
}

function headerValues(header: string | string[] | undefined): string[] {
	if (!header) return [];
	const joined = Array.isArray(header) ? header.join(',') : header;
	return joined
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

export interface OriginCheckInput {
	/** `req.ip` — already resolved through Express's `trust proxy` setting. */
	ip: string | undefined;
	/** Raw `req.headers['x-forwarded-for']`. */
	xForwardedFor: string | string[] | undefined;
	/** Raw `req.headers['cf-connecting-ip']`. */
	cfConnectingIp: string | string[] | undefined;
}

/**
 * Is this request local, as far as we can tell? See the module doc comment
 * for what this does and does not guarantee.
 */
export function isPrivateNetworkRequest(input: OriginCheckInput): boolean {
	// Cloudflare adds this at its edge — its mere presence means the request
	// came in over the internet, however local it looks by the time it
	// reaches us.
	if (input.cfConnectingIp) return false;
	if (!isPrivateIp(input.ip)) return false;
	// Every hop recorded in X-Forwarded-For must also be private — a chain
	// that touched a public address anywhere means internet traffic passed
	// through a local proxy on its way here.
	return headerValues(input.xForwardedFor).every((entry) => isPrivateIp(entry));
}
