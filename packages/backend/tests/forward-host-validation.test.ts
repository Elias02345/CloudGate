/**
 * Guards `isValidForwardHost` from both directions.
 *
 * It exists to stop config injection, and the first version did — by also
 * rejecting `jellyfin`, `localhost` and every other single-label origin,
 * because it reused the hostname rule written for the *public* names
 * CloudGate serves, which requires a dot. That would have 400'd on saving
 * any existing host pointing at a Docker service name.
 *
 * So the accept list here is as load-bearing as the reject list: a stricter
 * rule that breaks real homelab setups is not a safer rule.
 */

import { describe, expect, it } from 'vitest';
import { PathPrefixRegex, isValidForwardHost } from '@cloudgate/shared';

describe('isValidForwardHost — values real setups use', () => {
	it.each([
		'192.168.1.50',
		'10.0.0.2',
		'127.0.0.1',
		'localhost',
		'jellyfin',
		'homeassistant',
		'my-nas',
		'my_service', // Docker container names allow underscores
		'nas.local',
		'server.example.com',
		'fe80::1',
		'2001:db8::8a2e:370:7334',
	])('accepts %s', (value) => {
		expect(isValidForwardHost(value)).toBe(true);
	});
});

describe('isValidForwardHost — values that could escape an nginx directive', () => {
	it.each([
		'127.0.0.1; include /etc/passwd',
		'evil.com;}',
		'host with space',
		'host\nserver x',
		'{braces}',
		'"quoted"',
		'back\\slash',
		'',
	])('rejects %j', (value) => {
		expect(isValidForwardHost(value)).toBe(false);
	});
});

describe('PathPrefixRegex', () => {
	it.each(['/', '/app', '/media/movies', '/a-b_c.d~e'])('accepts %s', (value) => {
		expect(PathPrefixRegex.test(value)).toBe(true);
	});

	it.each([
		'/ { root /; try_files $uri =404; } location /dummy', // the reported exploit
		'/a;b',
		'/a b',
		'/a"b',
		"/a'b",
		'/a\\b',
		'no-leading-slash',
	])('rejects %j', (value) => {
		expect(PathPrefixRegex.test(value)).toBe(false);
	});
});
