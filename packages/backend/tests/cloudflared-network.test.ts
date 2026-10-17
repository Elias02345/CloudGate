/**
 * cloudflared network settings: config rendering, whitelist fallback, and the
 * HTTP/2 fallback decision.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderConfig } from '../src/services/tunnel-providers/cloudflared/config-writer.js';
import { shouldFallbackToHttp2 } from '../src/services/tunnel-providers/cloudflared/process.js';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-cfnet-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('cloudflared network settings', () => {
	it('renders protocol and edge-ip-version into config.yml', async () => {
		const yaml = await renderConfig({
			tunnel_id: 't',
			credentials_path: '/c.json',
			metrics_addr: '127.0.0.1:36500',
			protocol: 'http2',
			edge_ip_version: '4',
			hosts: [],
		});
		expect(yaml).toContain('protocol: http2');
		expect(yaml).toContain('edge-ip-version: "4"');
	});

	it('defaults, saves, and falls back to defaults on invalid stored values', async () => {
		const { getCloudflaredNetworkSettings, setCloudflaredNetworkSettings } = await import(
			'../src/services/tunnel-providers/cloudflared/network-settings.js'
		);
		const { getDb } = await import('../src/db/db.js');
		expect(await getCloudflaredNetworkSettings()).toEqual({ protocol: 'auto', edge_ip_version: '4' });

		expect(await setCloudflaredNetworkSettings({ protocol: 'http2' })).toEqual({
			protocol: 'http2',
			edge_ip_version: '4',
		});

		const now = new Date().toISOString();
		await getDb()('settings')
			.insert([
				{ key: 'cloudflared.protocol', value: '"evil\nx: y"', updated_at: now },
				{ key: 'cloudflared.edge_ip_version', value: 'not json {', updated_at: now },
			])
			.onConflict('key')
			.merge();
		expect(await getCloudflaredNetworkSettings()).toEqual({ protocol: 'auto', edge_ip_version: '4' });
	});
});

describe('shouldFallbackToHttp2', () => {
	it('only falls back in auto mode, once, after 60s without readiness', () => {
		expect(shouldFallbackToHttp2('auto', false, 61_000, false)).toBe(true);
		expect(shouldFallbackToHttp2('auto', false, 30_000, false)).toBe(false);
		expect(shouldFallbackToHttp2('auto', false, 61_000, true)).toBe(false);
		expect(shouldFallbackToHttp2('auto', true, 61_000, false)).toBe(false);
		expect(shouldFallbackToHttp2('http2', false, 61_000, false)).toBe(false);
		expect(shouldFallbackToHttp2('quic', false, 61_000, false)).toBe(false);
	});
});
