/**
 * Renders /data/cloudflared/config.yml from DB host records.
 *
 * Atomic write: temp file + fs.rename, never partial writes.
 * Always re-renders the full file from current DB state — never mutates in place.
 */

import { rename, writeFile } from 'node:fs/promises';
import { Liquid } from 'liquidjs';
import { dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';

const log = childLogger('tunnel-config');

// Inlined so tsc build doesn't need to copy .liquid files into dist/.
// Source-of-truth file is templates/cloudflared-config.yml.liquid (kept for editor tooling).
const CONFIG_TEMPLATE = `tunnel: {{ tunnel_id }}
credentials-file: {{ credentials_path }}
metrics: {{ metrics_addr }}
no-autoupdate: true

ingress:
{%- for host in hosts %}
  - hostname: {{ host.hostname }}
    {%- if host.path_prefix and host.path_prefix != '/' %}
    path: ^{{ host.path_prefix }}.*$
    {%- endif %}
    service: {{ host.forward_scheme }}://{{ host.forward_host }}:{{ host.forward_port }}
    {%- if host.no_tls_verify %}
    originRequest:
      noTLSVerify: true
    {%- endif %}
{%- endfor %}
  - service: http_status:404
`;

// trimTagLeft strips whitespace around {% for %} blocks for clean YAML.
// trimOutputLeft would strip the space after 'key: ' so we leave it off.
const engine = new Liquid({ trimTagLeft: true });

export interface RenderHost {
	hostname: string;
	path_prefix: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	no_tls_verify: boolean;
}

export interface RenderContext {
	tunnel_id: string;
	credentials_path: string;
	metrics_addr: string;
	hosts: RenderHost[];
}

export async function renderConfig(ctx: RenderContext): Promise<string> {
	return engine.parseAndRender(CONFIG_TEMPLATE, ctx);
}

/**
 * Atomic write — temp + rename. Returns the path written.
 */
export async function writeConfig(ctx: RenderContext): Promise<string> {
	const outPath = dataPath('cloudflared', 'config.yml');
	const tmpPath = `${outPath}.${process.pid}.tmp`;
	const yaml = await renderConfig(ctx);
	await writeFile(tmpPath, yaml, { encoding: 'utf8', mode: 0o600 });
	await rename(tmpPath, outPath);
	log.info({ outPath, hosts: ctx.hosts.length }, 'Wrote cloudflared config');
	return outPath;
}

/**
 * Build the render context for a given tunnel by pulling its enabled hosts from DB.
 */
export async function buildContext(tunnelRow: {
	id: number;
	tunnel_id: string;
	credentials_path: string;
}): Promise<RenderContext> {
	const knex = getDb();
	type HostRow = {
		hostname: string;
		path_prefix: string;
		forward_scheme: string;
		forward_host: string;
		forward_port: number;
		tls_options: string;
	};
	const rows = await knex<HostRow>('proxy_hosts')
		.where({ tunnel_id: tunnelRow.id, enabled: true, mode: 'cloudflare_tunnel' })
		.select('hostname', 'path_prefix', 'forward_scheme', 'forward_host', 'forward_port', 'tls_options');

	const hosts: RenderHost[] = rows.map((r) => {
		let tls: { no_tls_verify?: boolean } = {};
		try {
			tls = typeof r.tls_options === 'string' ? JSON.parse(r.tls_options) : (r.tls_options ?? {});
		} catch {
			tls = {};
		}
		return {
			hostname: r.hostname,
			path_prefix: r.path_prefix,
			forward_scheme: r.forward_scheme,
			forward_host: r.forward_host,
			forward_port: r.forward_port,
			no_tls_verify: Boolean(tls.no_tls_verify),
		};
	});

	return {
		tunnel_id: tunnelRow.tunnel_id,
		credentials_path: tunnelRow.credentials_path,
		metrics_addr: '127.0.0.1:36500',
		hosts,
	};
}
