/**
 * nginx host-template test.
 *
 * Guards the local_nginx render path. Two things are checked:
 *
 *  1. The rendered config is *syntactically valid nginx*. This is not
 *     theoretical: the template used to be rendered by a Liquid engine with
 *     `trimOutputLeft: true`, which ate the space in `server {{ forward_host }}`
 *     and produced `server192.168.1.50:8123;` — a config that fails `nginx -t`,
 *     so no local_nginx host could ever deploy. A string assertion would not
 *     have caught it; running the real binary does. When nginx isn't installed
 *     (most dev machines) that half is skipped, and the whitespace-sensitive
 *     directives are asserted textually instead so the regression still can't
 *     come back silently.
 *
 *  2. Each `forwarded_headers` mode emits the headers it promises — this is
 *     what makes Home Assistant work or fail behind CloudGate.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RenderHost, renderHostConfig } from '../src/services/nginx-config.js';

const execFileAsync = promisify(execFile);

let tmpDir: string;
let nginxAvailable = false;

const baseHost: RenderHost = {
	id: 1,
	hostname: 'ha.example.com',
	forward_scheme: 'http',
	forward_host: '192.168.1.50',
	forward_port: 8123,
	path_prefix: '/',
	no_tls_verify: false,
};

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-nginx-'));
	try {
		await execFileAsync('nginx', ['-v']);
		nginxAvailable = true;
	} catch {
		nginxAvailable = false;
	}
});

afterAll(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the rendered configs through a real `nginx -t`, laid out the way the
 * container does it: included from inside an `http { }` block.
 *
 * The `[::]` listeners are dropped because CI containers frequently have no
 * IPv6 stack, and `socket() [::]:80 failed` would fail the test for reasons
 * that have nothing to do with the template.
 */
async function assertNginxAccepts(configs: string[]): Promise<void> {
	const root = join(tmpDir, `case-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, 'hosts'), { recursive: true });
	configs.forEach((conf, i) => {
		const withoutV6 = conf
			.split('\n')
			.filter((l) => !l.includes('[::]'))
			.join('\n');
		writeFileSync(join(root, 'hosts', `${i + 1}.conf`), withoutV6);
	});
	writeFileSync(
		join(root, 'nginx.conf'),
		[
			'worker_processes 1;',
			`error_log ${join(root, 'error.log')};`,
			`pid ${join(root, 'nginx.pid')};`,
			'events { worker_connections 64; }',
			'http {',
			'  access_log off;',
			`  client_body_temp_path ${join(root, 'body')};`,
			`  proxy_temp_path ${join(root, 'proxy')};`,
			`  fastcgi_temp_path ${join(root, 'fastcgi')};`,
			`  uwsgi_temp_path ${join(root, 'uwsgi')};`,
			`  scgi_temp_path ${join(root, 'scgi')};`,
			'  server { listen 8099 default_server; server_name _; }',
			`  include ${join(root, 'hosts')}/*.conf;`,
			'}',
		].join('\n')
	);

	// `nginx -t` writes its verdict to stderr and exits non-zero on failure,
	// so a rejection surfaces as a thrown error carrying the reason.
	await execFileAsync('nginx', ['-t', '-c', join(root, 'nginx.conf')]);
}

describe('nginx host template', () => {
	it('separates directives from their arguments', async () => {
		const conf = await renderHostConfig(baseHost);
		// The exact shapes the trimOutputLeft bug destroyed.
		expect(conf).toContain('server 192.168.1.50:8123;');
		expect(conf).toContain('server_name ha.example.com;');
		expect(conf).toContain('proxy_pass http://cloudgate_host_1;');
		expect(conf).not.toMatch(/server192\.168/);
		expect(conf).not.toMatch(/server_nameha/);
	});

	it('does not run the TLS block into the preceding directive', async () => {
		const conf = await renderHostConfig({
			...baseHost,
			cert_path: '/data/nginx/certs/ha.crt',
			cert_key_path: '/data/nginx/certs/ha.key',
		});
		expect(conf).not.toMatch(/;listen 443/);
		expect(conf).toContain('ssl_certificate /data/nginx/certs/ha.crt;');
	});

	it('only sends Connection: upgrade when the client asked for one', async () => {
		const conf = await renderHostConfig(baseHost);
		// Per-host variable name: two host files must be able to coexist in
		// the same http{} block without redeclaring the same map variable.
		expect(conf).toContain('map $http_upgrade $cg_conn_upgrade_1 {');
		expect(conf).toContain('proxy_set_header Connection $cg_conn_upgrade_1;');
		expect(conf).not.toContain('proxy_set_header Connection "upgrade";');
	});

	it('is self-contained — declares every variable it uses', async () => {
		const conf = await renderHostConfig(baseHost);
		// The self-updater never replaces the image-level nginx config, so a
		// host file may not depend on anything declared there.
		const used = [...conf.matchAll(/\$cg_[a-z_0-9]+/g)].map((m) => m[0]);
		expect(used.length).toBeGreaterThan(0);
		for (const variable of new Set(used)) {
			expect(conf).toContain(`map $http_upgrade ${variable} {`);
		}
	});

	describe('forwarded_headers', () => {
		it('defaults to appending our hop, preserving the client IP', async () => {
			const conf = await renderHostConfig(baseHost);
			expect(conf).toContain('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
		});

		it('client_ip_only sends exactly one entry', async () => {
			const conf = await renderHostConfig({ ...baseHost, forwarded_headers: 'client_ip_only' });
			expect(conf).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
			expect(conf).not.toContain('$proxy_add_x_forwarded_for');
		});

		it('strip omits every forwarded header', async () => {
			const conf = await renderHostConfig({ ...baseHost, forwarded_headers: 'strip' });
			// An empty value is how nginx is told to drop a header entirely.
			expect(conf).toContain('proxy_set_header X-Forwarded-For "";');
			expect(conf).toContain('proxy_set_header X-Forwarded-Proto "";');
			expect(conf).toContain('proxy_set_header X-Forwarded-Host "";');
			expect(conf).not.toContain('$proxy_add_x_forwarded_for');
		});
	});

	describe('Host header override', () => {
		it('defaults to $host', async () => {
			const conf = await renderHostConfig(baseHost);
			expect(conf).toContain('proxy_set_header Host $host;');
		});

		it('quotes an explicit override', async () => {
			const conf = await renderHostConfig({ ...baseHost, http_host_header: 'homeassistant.local:8123' });
			expect(conf).toContain('proxy_set_header Host "homeassistant.local:8123";');
		});

		it('strips characters that could terminate a directive', async () => {
			const conf = await renderHostConfig({
				...baseHost,
				http_host_header: 'ha.local; } server { listen 1234; #',
			});
			expect(conf).not.toMatch(/proxy_set_header Host "[^"]*[;{}]/);
			// One server block in, one server block out.
			expect(conf.match(/^server \{/gm)?.length ?? 0).toBe(1);
		});
	});

	it('produces a config real nginx accepts', async () => {
		if (!nginxAvailable) {
			// Textual assertions above still cover the regression; skip the
			// binary check rather than failing on machines without nginx.
			return;
		}
		const configs = await Promise.all([
			renderHostConfig({ ...baseHost, id: 1 }),
			renderHostConfig({ ...baseHost, id: 2, forwarded_headers: 'standard' }),
			renderHostConfig({ ...baseHost, id: 3, forwarded_headers: 'client_ip_only' }),
			renderHostConfig({ ...baseHost, id: 4, forwarded_headers: 'strip' }),
			renderHostConfig({
				...baseHost,
				id: 5,
				hostname: 'other.example.com',
				forwarded_headers: 'strip',
				http_host_header: 'ha.local; } evil {',
				no_tls_verify: true,
				forward_scheme: 'https',
			}),
		]);
		await expect(assertNginxAccepts(configs)).resolves.toBeUndefined();
	});
});
