/**
 * DNS verification — confirms a hostname's CNAME has actually propagated
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
	| { kind: 'ok'; cname: string; ttl: number; latency_ms: number }
	| { kind: 'wrong_target'; expected: string; got: string }
	| { kind: 'no_record'; message: string }
	| { kind: 'nxdomain'; message: string }
	| { kind: 'timeout'; message: string }
	| { kind: 'error'; message: string };

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
const TYPE_CNAME = 5;
const NXDOMAIN_RCODE = 3;

/**
 * Single DoH query against 1.1.1.1 for the CNAME record. Returns the
 * answer chain — we expect [hostname → tunnel-uuid.cfargotunnel.com].
 */
async function dohQuery(hostname: string, timeoutMs = 4000): Promise<DohResponse | null> {
	const url = `${CF_DOH}?name=${encodeURIComponent(hostname)}&type=CNAME`;
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

/**
 * Verify a single hostname resolves to the expected CNAME target. Polls
 * up to `attempts` times with 2s gap if the record isn't there yet —
 * lets the create call's propagation catch up. Returns the FIRST
 * outcome that isn't a "still propagating" state.
 */
export async function verifyDns(
	hostname: string,
	expectedCnameSuffix: string,
	options: { attempts?: number; intervalMs?: number } = {},
): Promise<DnsVerifyOutcome> {
	const attempts = options.attempts ?? 6;
	const intervalMs = options.intervalMs ?? 2000;
	const start = Date.now();

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

		const answers = (resp.Answer ?? []).filter((a) => a.type === TYPE_CNAME);
		if (answers.length === 0) {
			// Record might still be propagating, or wrong type. Retry.
			if (i < attempts - 1) {
				await sleep(intervalMs);
				continue;
			}
			return {
				kind: 'no_record',
				message: `No CNAME found for ${hostname} after ${(attempts * intervalMs) / 1000}s. The record may still be propagating, or the create call silently failed.`,
			};
		}

		const target = answers[answers.length - 1]?.data ?? '';
		const cleanTarget = target.replace(/\.$/, '').toLowerCase();
		const cleanExpected = expectedCnameSuffix.replace(/\.$/, '').toLowerCase();

		if (!cleanTarget.endsWith(cleanExpected)) {
			return {
				kind: 'wrong_target',
				expected: cleanExpected,
				got: cleanTarget,
			};
		}

		const ttl = answers[answers.length - 1]?.TTL ?? 0;
		log.info({ hostname, target: cleanTarget, ttl, attempts: i + 1 }, 'DNS verified');
		return {
			kind: 'ok',
			cname: cleanTarget,
			ttl,
			latency_ms: Date.now() - start,
		};
	}

	return { kind: 'timeout', message: `DNS verification gave up after ${attempts} attempts` };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
