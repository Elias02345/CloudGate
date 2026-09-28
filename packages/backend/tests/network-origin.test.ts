/**
 * Table-driven coverage for the private-network classifier that gates
 * POST /api/setup and POST /api/restore/first-run.
 */

import { describe, expect, it } from 'vitest';
import { isPrivateIp, isPrivateNetworkRequest } from '../src/services/network-origin.js';

describe('isPrivateIp', () => {
	const privateCases: [string, string][] = [
		['loopback IPv4', '127.0.0.1'],
		['loopback IPv4, other host part', '127.10.20.30'],
		['RFC1918 10/8', '10.1.2.3'],
		['RFC1918 172.16/12 lower bound', '172.16.0.1'],
		['RFC1918 172.16/12 upper bound', '172.31.255.254'],
		['RFC1918 192.168/16', '192.168.1.42'],
		['CGNAT 100.64/10 (Tailscale)', '100.64.0.1'],
		['CGNAT 100.64/10 upper bound', '100.127.255.254'],
		['link-local IPv4', '169.254.1.1'],
		['loopback IPv6', '::1'],
		['IPv6 ULA fc00::/7', 'fc00::1'],
		['IPv6 ULA fd00::/8', 'fd12:3456:789a::1'],
		['IPv6 link-local', 'fe80::1'],
		['IPv6 link-local with zone id', 'fe80::1%eth0'],
		['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1'],
		['IPv4-mapped IPv6 RFC1918', '::ffff:10.0.0.5'],
		['bracketed IPv6', '[::1]'],
	];

	const publicCases: [string, string][] = [
		['public IPv4', '8.8.8.8'],
		['public IPv4, Cloudflare range', '1.1.1.1'],
		['just outside 172.16/12', '172.32.0.1'],
		['just outside 100.64/10', '100.128.0.1'],
		['public IPv6', '2001:4860:4860::8888'],
		['IPv4-mapped IPv6 public', '::ffff:8.8.8.8'],
		['empty string', ''],
		['garbage', 'not-an-ip'],
	];

	it.each(privateCases)('%s (%s) is private', (_label, ip) => {
		expect(isPrivateIp(ip)).toBe(true);
	});

	it.each(publicCases)('%s (%s) is not private', (_label, ip) => {
		expect(isPrivateIp(ip)).toBe(false);
	});

	it('treats undefined/null as not private', () => {
		expect(isPrivateIp(undefined)).toBe(false);
		expect(isPrivateIp(null)).toBe(false);
	});
});

describe('isPrivateNetworkRequest', () => {
	it('allows a plain loopback request with no forwarding headers', () => {
		expect(
			isPrivateNetworkRequest({ ip: '127.0.0.1', xForwardedFor: undefined, cfConnectingIp: undefined })
		).toBe(true);
	});

	it('allows a LAN request forwarded through the container-local nginx', () => {
		expect(
			isPrivateNetworkRequest({ ip: '192.168.1.50', xForwardedFor: '192.168.1.50', cfConnectingIp: undefined })
		).toBe(true);
	});

	it('rejects when req.ip resolves to a public address', () => {
		expect(isPrivateNetworkRequest({ ip: '8.8.8.8', xForwardedFor: undefined, cfConnectingIp: undefined })).toBe(
			false
		);
	});

	it('rejects any request carrying CF-Connecting-IP, even from a private req.ip', () => {
		expect(
			isPrivateNetworkRequest({ ip: '127.0.0.1', xForwardedFor: undefined, cfConnectingIp: '203.0.113.5' })
		).toBe(false);
	});

	it('rejects when any X-Forwarded-For hop is public (tunnel/proxy fronting internet traffic)', () => {
		expect(
			isPrivateNetworkRequest({
				ip: '172.18.0.1',
				xForwardedFor: '203.0.113.9, 172.18.0.1',
				cfConnectingIp: undefined,
			})
		).toBe(false);
	});

	it('allows a multi-hop X-Forwarded-For chain that stays entirely private', () => {
		expect(
			isPrivateNetworkRequest({
				ip: '172.18.0.1',
				xForwardedFor: '192.168.1.50, 172.18.0.1',
				cfConnectingIp: undefined,
			})
		).toBe(true);
	});

	it('handles an array-valued header (Node can deliver headers this way)', () => {
		expect(
			isPrivateNetworkRequest({ ip: '127.0.0.1', xForwardedFor: ['10.0.0.5', '127.0.0.1'], cfConnectingIp: undefined })
		).toBe(true);
	});
});
