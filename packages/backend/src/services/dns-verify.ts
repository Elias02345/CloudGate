/**
 * DNS verification — confirms a hostname's tunnel record has actually propagated
 * to Cloudflare's public resolvers.
 *
 * Why this exists:
 *   The Cloudflare SDK's `dns.records.create()` returning success only
 *   tells us the record was accepted by their API. It doesn't tell us
 *   the record is queryable from outside. In practice it propagates in
 *   a few seconds, but rare edge cases (zone not actually active,
 *   duplicate-but-disabled records, regional propagation lag) leave
 *   CloudGate cheerfully showing "deployed" while users see
 *   DNS_PROBE_POSSIBLE in their browser.
 *
 *   We verify via DNS-over-HTTPS against 1.1.1.1 (Cloudflare's own
 *   public resolver). DoH bypasses the container's local DNS cache, so
 *   we always see the current authoritative answer. Cloudflare's
 *   authoritative + public-resolver are tightly coupled — if 1.1.1.1
 *   says the record exists, the rest of the internet will catch up in
 *   seconds.
 *
 * Browser caching is a different issue we cannot fix server-side —
 * documented in the UI as a hint when the record IS verified but the
 * user reports the browser still fails.
 */

import { childLogger } from '../logger.js';

const log = childLogger('dns-verify');

export type DnsVerifyOutcome =
	| { kind: 'ok'; cname: string; ttl: number; latency_ms: number; proxied: boolean }
	| { kind: 'wrong_target'; expected: string; got: string }
	| { kind: 'no_record'; message: string }
	| { kind: 'nxdomain'; message: string }
	| { kind: 'timeout'; message: string }
	| { kind: 'error'; message: string };

/** A record as Cloudflare's API reports it for the verified hostname. */
export interface ZoneRecord {
	type: string;
	content: string;
	proxied: boolean;
}

interface DohAnswer {
	name: string;
	type: number;
	TTL: number;
	data: string;
}

interface DohResponse {
	Status: number;
	TC?: boolean;
	RD?: boolean;
	RA?: boolean;
	AD?: boolean;
	CD?: boolean;
	Question: Array<{ name: string; type: number }>;
	Answer?: DohAnswer[];
	Authority?: DohAnswer[];
}

const CF_DOH = 'https://cloudflare-dns.com/dns-query';
const TYPE_A = 1;
const TYPE_CNAME = 5;
const TYPE_AAAA = 28;
const NXDOMAIN_RCODE = 3;

/**
 * Single DoH query against 1.1.1.1 for the hostname's A record. Asking for
 * A (not CNAME) matters: a proxied CNAME — which every tunnel hostname is —
 * is flattened by Cloudflare and only ever answers with edge A/AAAA
 * addresses. An unproxied CNAME still shows up as a CNAME in the chain.
 */
async function dohQuery(hostname: string, timeoutMs = 4000): Promise<DohResponse | null> {
	const url = `${CF_DOH}?name=${encodeURIComponent(hostname)}&type=A`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { accept: 'application/dns-json' },
			signal: ctrl.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		return (await res.json()) as DohResponse;
	} catch {
		clearTimeout(timer);
		return null;
	}
}

function clean(name: string): string {
	return name.replace(/\.$/, '').toLowerCase();
}

/**
 * Verify a single hostname is published and points at the expected tunnel.
 * Polls up to `attempts` times with a gap if the record isn't there yet —
 * lets the create call's propagation catch up. Returns the FIRST outcome
 * that isn't a "still propagating" state.
 *
 * Public DNS proves the name resolves. For a proxied record it cannot show
 * the CNAME target, so `lookupRecords` (Cloudflare's API) supplies it.
 * Without a lookup, a resolving proxied name counts as verified.
 */
export async function verifyDns(
	hostname: string,
	expectedCnameSuffix: string,
	options: {
		attempts?: number;
		intervalMs?: number;
		lookupRecords?: () => Promise<ZoneRecord[]>;
	} = {}
): Promise<DnsVerifyOutcome> {
	const attempts = options.attempts ?? 6;
	const intervalMs = options.intervalMs ?? 2000;
	const start = Date.now();
	const cleanExpected = clean(expectedCnameSuffix);

	for (let i = 0; i < attempts; i++) {
		const resp = await dohQuery(hostname);
		if (!resp) {
			if (i === attempts - 1) {
				return { kind: 'timeout', message: 'No response from 1.1.1.1 DoH endpoint after retries' };
			}
			await sleep(intervalMs);
			continue;
		}

		if (resp.Status === NXDOMAIN_RCODE) {
			// NXDOMAIN — record genuinely doesn't exist. Don't bother retrying
			// for transient propagation: NXDOMAIN means the authoritative NS
			// rejected the name.
			return {
				kind: 'nxdomain',
				message: `Cloudflare's DNS resolver returned NXDOMAIN for ${hostname}. The record was not created — re-check the host in CloudGate or your CF dashboard.`,
			};
		}

		const answers = resp.Answer ?? [];
		const cnames = answers.filter((a) => a.type === TYPE_CNAME);
		const addresses = answers.filter((a) => a.type === TYPE_A || a.type === TYPE_AAAA);

		if (cnames.length === 0 && addresses.length === 0) {
			// Record might still be propagating. Retry.
			if (i < attempts - 1) {
				await sleep(intervalMs);
				continue;
			}
			return {
				kind: 'no_record',
				message: `No DNS record found for ${hostname} after ${(attempts * intervalMs) / 1000}s. The record may still be propagating, or the create call silently failed.`,
			};
		}

		// Unproxied CNAME: the chain is visible, check it directly.
		if (cnames.length > 0) {
			const match = cnames.find((a) => clean(a.data).endsWith(cleanExpected));
			if (!match) {
				return { kind: 'wrong_target', expected: cleanExpected, got: clean(cnames[0]?.data ?? '') };
			}
			log.info({ hostname, target: clean(match.data), attempts: i + 1 }, 'DNS verified');
			return {
				kind: 'ok',
				cname: clean(match.data),
				ttl: match.TTL,
				latency_ms: Date.now() - start,
				proxied: false,
			};
		}

		// Proxied (flattened) record: public DNS only shows edge addresses.
		const ttl = addresses[0]?.TTL ?? 0;
		const resolvesOk = (): DnsVerifyOutcome => ({
			kind: 'ok',
			cname: clean(addresses[0]?.data ?? ''),
			ttl,
			latency_ms: Date.now() - start,
			proxied: true,
		});
		if (!options.lookupRecords) {
			log.info({ hostname, attempts: i + 1 }, 'DNS verified (proxied, target not checked)');
			return resolvesOk();
		}
		let records: ZoneRecord[];
		try {
			records = await options.lookupRecords();
		} catch (err) {
			// The name resolves; we just can't read the target. Don't fail.
			log.warn({ hostname, err: (err as Error).message }, 'DNS record lookup failed — trusting public DNS');
			return resolvesOk();
		}
		const cname = records.find((r) => r.type.toUpperCase() === 'CNAME');
		if (cname && clean(cname.content).endsWith(cleanExpected)) {
			log.info({ hostname, target: clean(cname.content), attempts: i + 1 }, 'DNS verified (proxied)');
			return { kind: 'ok', cname: clean(cname.content), ttl, latency_ms: Date.now() - start, proxied: true };
		}
		const other = cname ?? records[0];
		return {
			kind: 'wrong_target',
			expected: cleanExpected,
			got: other
				? `${other.type} ${clean(other.content)}`
				: `no record for ${hostname} in the zone (a wildcard record may be answering)`,
		};
	}

	return { kind: 'timeout', message: `DNS verification gave up after ${attempts} attempts` };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
