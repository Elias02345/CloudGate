/**
 * DNS verification (issue #104).
 *
 * Every tunnel hostname is a proxied CNAME, and Cloudflare flattens those:
 * public DNS answers with edge A/AAAA addresses and never shows the CNAME.
 * The old check asked 1.1.1.1 for a CNAME and so reported "no record" for
 * every working host. These tests stub the DoH endpoint with the answers
 * Cloudflare really returns.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyDns } from '../src/services/dns-verify.js';

const HOST = 'app.example.com';
const TARGET = '6f1d3c1e-0000-4000-8000-000000000001.cfargotunnel.com';

function stubDoh(body: object): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
	);
}

const proxiedAnswer = {
	Status: 0,
	Question: [{ name: HOST, type: 1 }],
	Answer: [
		{ name: HOST, type: 1, TTL: 300, data: '104.21.10.1' },
		{ name: HOST, type: 1, TTL: 300, data: '172.67.200.2' },
	],
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('verifyDns', () => {
	it('queries type A, not CNAME', async () => {
		stubDoh(proxiedAnswer);
		await verifyDns(HOST, TARGET, { attempts: 1, intervalMs: 0 });
		const url = String(vi.mocked(fetch).mock.calls[0]?.[0]);
		expect(url).toContain('type=A');
		expect(url).not.toContain('type=CNAME');
	});

	it('accepts a proxied record whose zone CNAME points at the tunnel', async () => {
		stubDoh(proxiedAnswer);
		const result = await verifyDns(HOST, TARGET, {
			attempts: 1,
			intervalMs: 0,
			lookupRecords: async () => [{ type: 'CNAME', content: TARGET, proxied: true }],
		});
		expect(result).toMatchObject({ kind: 'ok', cname: TARGET, proxied: true });
	});

	it('reports a proxied record that points somewhere else', async () => {
		stubDoh(proxiedAnswer);
		const result = await verifyDns(HOST, TARGET, {
			attempts: 1,
			intervalMs: 0,
			lookupRecords: async () => [{ type: 'A', content: '203.0.113.5', proxied: true }],
		});
		expect(result).toMatchObject({ kind: 'wrong_target', got: 'A 203.0.113.5' });
	});

	it('trusts public DNS when the API lookup fails', async () => {
		stubDoh(proxiedAnswer);
		const result = await verifyDns(HOST, TARGET, {
			attempts: 1,
			intervalMs: 0,
			lookupRecords: async () => {
				throw new Error('token lacks DNS read');
			},
		});
		expect(result).toMatchObject({ kind: 'ok', proxied: true });
	});

	it('still checks an unproxied CNAME chain directly', async () => {
		stubDoh({
			Status: 0,
			Question: [{ name: HOST, type: 1 }],
			Answer: [{ name: HOST, type: 5, TTL: 60, data: `${TARGET}.` }],
		});
		const ok = await verifyDns(HOST, TARGET, { attempts: 1, intervalMs: 0 });
		expect(ok).toMatchObject({ kind: 'ok', cname: TARGET, proxied: false });

		stubDoh({
			Status: 0,
			Question: [{ name: HOST, type: 1 }],
			Answer: [{ name: HOST, type: 5, TTL: 60, data: 'old-server.example.net.' }],
		});
		const wrong = await verifyDns(HOST, TARGET, { attempts: 1, intervalMs: 0 });
		expect(wrong).toMatchObject({ kind: 'wrong_target', got: 'old-server.example.net' });
	});

	it('reports NXDOMAIN and empty answers', async () => {
		stubDoh({ Status: 3, Question: [{ name: HOST, type: 1 }] });
		expect((await verifyDns(HOST, TARGET, { attempts: 1, intervalMs: 0 })).kind).toBe('nxdomain');

		stubDoh({ Status: 0, Question: [{ name: HOST, type: 1 }] });
		expect((await verifyDns(HOST, TARGET, { attempts: 1, intervalMs: 0 })).kind).toBe('no_record');
	});
});
