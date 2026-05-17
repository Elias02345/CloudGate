/**
 * Tunnel-config-writer test.
 *
 * Exercises the Liquid template + atomic write path. Doesn't actually spawn
 * cloudflared — just verifies the file content + that writes are atomic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-tcw-'));
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

describe('tunnel-config-writer', () => {
	it('renders an empty ingress list with the catch-all 404', async () => {
		const { renderConfig } = await import('../src/services/tunnel-config-writer.js');
		const yaml = await renderConfig({
			tunnel_id: 'abc-uuid',
			credentials_path: '/data/cloudflared/abc.json',
			metrics_addr: '127.0.0.1:36500',
			hosts: [],
		});
		expect(yaml).toContain('tunnel: abc-uuid');
		expect(yaml).toContain('credentials-file: /data/cloudflared/abc.json');
		expect(yaml).toContain('metrics: 127.0.0.1:36500');
		expect(yaml).toContain('service: http_status:404');
	});

	it('renders multiple hosts with correct service URLs', async () => {
		const { renderConfig } = await import('../src/services/tunnel-config-writer.js');
		const yaml = await renderConfig({
			tunnel_id: 'tid',
			credentials_path: '/p/cred.json',
			metrics_addr: '127.0.0.1:36500',
			hosts: [
				{
					hostname: 'a.example.com',
					path_prefix: '/',
					forward_scheme: 'http',
					forward_host: '192.168.1.10',
					forward_port: 8080,
					no_tls_verify: false,
				},
				{
					hostname: 'b.example.com',
					path_prefix: '/',
					forward_scheme: 'https',
					forward_host: '10.0.0.5',
					forward_port: 8443,
					no_tls_verify: true,
				},
			],
		});
		expect(yaml).toContain('hostname: a.example.com');
		expect(yaml).toContain('http://192.168.1.10:8080');
		expect(yaml).toContain('hostname: b.example.com');
		expect(yaml).toContain('https://10.0.0.5:8443');
		expect(yaml).toContain('noTLSVerify: true');
	});

	it('writeConfig produces an atomic file (no stray .tmp)', async () => {
		const { writeConfig } = await import('../src/services/tunnel-config-writer.js');
		await writeConfig({
			tunnel_id: 'wtest',
			credentials_path: '/p/c.json',
			metrics_addr: '127.0.0.1:36500',
			hosts: [],
		});
		const dir = join(tmpDir, 'cloudflared');
		const files = readdirSync(dir);
		expect(files).toContain('config.yml');
		// No .tmp files should remain after atomic rename
		expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
		const content = readFileSync(join(dir, 'config.yml'), 'utf8');
		expect(content).toContain('tunnel: wtest');
	});
});
