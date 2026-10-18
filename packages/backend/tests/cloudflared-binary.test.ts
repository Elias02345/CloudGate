import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	CLOUDFLARED_PINNED,
	compareVersions,
	parseCloudflaredVersion,
} from '../src/services/tunnel-providers/cloudflared/binary.js';
import { describeCloudflaredFailure } from '../src/services/tunnel-providers/cloudflared/process.js';

describe('parseCloudflaredVersion', () => {
	it('parses real output', () => {
		expect(parseCloudflaredVersion('cloudflared version 2026.5.0 (built 2026-05-10-1200 UTC)\n')).toBe(
			'2026.5.0'
		);
	});
	it('returns null for garbage', () => {
		expect(parseCloudflaredVersion('command not found')).toBeNull();
	});
});

describe('compareVersions', () => {
	it('compares numerically per segment', () => {
		expect(compareVersions('2026.5.0', '2026.9.1')).toBeLessThan(0);
		expect(compareVersions('2026.10.0', '2026.9.1')).toBeGreaterThan(0);
		expect(compareVersions('2026.9.1', '2026.9.1')).toBe(0);
	});
});

describe('describeCloudflaredFailure', () => {
	it('explains a blocked edge port', () => {
		const line =
			'2026-10-17T21:34:26Z ERR Serve tunnel error error="DialContext error: dial tcp 198.41.200.233:7844: i/o timeout" connIndex=0 event=0 ip=198.41.200.233';
		const out = describeCloudflaredFailure(line);
		expect(out).toContain('Cannot reach the Cloudflare Tunnel edge on port 7844');
		expect(out).toContain('198.41.200.0/24');
		expect(out).toContain('i/o timeout');
	});
	it('leaves unrelated lines unchanged', () => {
		const line = '2026-10-17T21:34:26Z ERR something else broke';
		expect(describeCloudflaredFailure(line)).toBe(line);
	});
});

describe('pinned version', () => {
	it('matches CLOUDFLARED_VERSION in docker/Dockerfile', () => {
		const dockerfile = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docker', 'Dockerfile'),
			'utf8'
		);
		expect(/^ARG CLOUDFLARED_VERSION=(\S+)/m.exec(dockerfile)?.[1]).toBe(CLOUDFLARED_PINNED.version);
	});
});
