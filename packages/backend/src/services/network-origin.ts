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

function ipv4ToInt(ip: string): number | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return null;
	const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if ([a, b, c, d].some((o) => o < 0 || o > 255)) return null;
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inIpv4Range(ip: string, base: string, prefixBits: number): boolean {
	const ipInt = ipv4ToInt(ip);
	const baseInt = ipv4ToInt(base);
	if (ipInt === null || baseInt === null) return false;
	const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
	return (ipInt & mask) === (baseInt & mask);
}

/** Expands a full (possibly `::`-compressed) IPv6 literal to a 128-bit value. */
function ipv6ToBigInt(ip: string): bigint | null {
	if (!ip.includes(':')) return null;
	let addr = ip;

	// Trailing IPv4-mapped tail, e.g. "::ffff:127.0.0.1" — fold it into two hextets.
	const v4Tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
	const v4TailText = v4Tail?.[1];
	if (v4TailText) {
		const v4Int = ipv4ToInt(v4TailText);
		if (v4Int === null) return null;
		const hex = v4Int.toString(16).padStart(8, '0');
		addr = `${addr.slice(0, addr.length - v4TailText.length)}${hex.slice(0, 4)}:${hex.slice(4)}`;
	}

	const halves = addr.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
	if (halves.length === 1 && head.length !== 8) return null;
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 && missing < 0) return null;
	const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
	if (groups.length !== 8) return null;

	let value = 0n;
	for (const g of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		value = (value << 16n) | BigInt(Number.parseInt(g, 16));
	}
	return value;
}

function inIpv6Range(ip: string, base: string, prefixBits: number): boolean {
	const ipVal = ipv6ToBigInt(ip);
	const baseVal = ipv6ToBigInt(base);
	if (ipVal === null || baseVal === null) return false;
	const shift = BigInt(128 - prefixBits);
	const fullMask = (1n << 128n) - 1n;
	const mask = shift === 0n ? fullMask : (fullMask >> shift) << shift;
	return (ipVal & mask) === (baseVal & mask);
}

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

	const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(clean);
	const v4 = mapped?.[1] ?? clean;
	if (ipv4ToInt(v4) !== null) {
		return (
			inIpv4Range(v4, '127.0.0.0', 8) || // loopback
			inIpv4Range(v4, '10.0.0.0', 8) || // RFC1918
			inIpv4Range(v4, '172.16.0.0', 12) || // RFC1918
			inIpv4Range(v4, '192.168.0.0', 16) || // RFC1918
			inIpv4Range(v4, '100.64.0.0', 10) || // CGNAT / Tailscale
			inIpv4Range(v4, '169.254.0.0', 16) // link-local
		);
	}

	if (clean.includes(':')) {
		if (clean === '::1') return true; // loopback
		return inIpv6Range(clean, 'fc00::', 7) || inIpv6Range(clean, 'fe80::', 10); // ULA / link-local
	}

	return false;
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
