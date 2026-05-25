/**
 * Renders /data/cloudflared/config.yml from DB host records.
 *
 * Atomic write: temp file + fs.rename, never partial writes.
 * Always re-renders the full file from current DB state — never mutates in place.
 *
 * cloudflared is HTTP-only — this writer skips hosts whose `protocol` is
 * not http/https. Non-HTTP hosts route through a different provider entirely.
 */

import { rename, writeFile } from 'node:fs/promises';
import { Liquid } from 'liquidjs';
import { dataPath } from '../../../config.js';
import { getDb } from '../../../db/db.js';
import { childLogger } from '../../../logger.js';

const log = childLogger('tunnel-config');

// Inlined so tsc build doesn't need to copy .liquid files into dist/.
//
// Note on `originRequest` block: we emit it once per host with whatever
// keys the user set, plus noTLSVerify if forward_scheme=https + the toggle.
// Order of keys doesn't matter to cloudflared, only indentation does
// — Liquid's `{%- -%}` strips surrounding whitespace so the YAML stays
// valid even when most fields are omitted.
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
    {%- if host.has_origin_request %}
    originRequest:
      {%- if host.no_tls_verify %}
      noTLSVerify: true
      {%- endif %}
      {%- if host.http_host_header %}
      httpHostHeader: "{{ host.http_host_header }}"
      {%- endif %}
      {%- if host.origin_server_name %}
      originServerName: "{{ host.origin_server_name }}"
      {%- endif %}
      {%- if host.no_happy_eyeballs %}
      noHappyEyeballs: true
      {%- endif %}
      {%- if host.http2_origin %}
      http2Origin: true
      {%- endif %}
      {%- if host.disable_chunked_encoding %}
      disableChunkedEncoding: true
      {%- endif %}
      {%- if host.connect_timeout %}
      connectTimeout: {{ host.connect_timeout }}
      {%- endif %}
      {%- if host.tls_timeout %}
      tlsTimeout: {{ host.tls_timeout }}
      {%- endif %}
    {%- endif %}
{%- endfor %}
  - service: http_status:404
`;

const engine = new Liquid({ trimTagLeft: true });

export interface RenderHost {
	hostname: string;
	path_prefix: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	no_tls_verify: boolean;
	/** True if any originRequest field is set — drives the block emission. */
	has_origin_request: boolean;
	http_host_header?: string;
	origin_server_name?: string;
	no_happy_eyeballs?: boolean;
	http2_origin?: boolean;
	disable_chunked_encoding?: boolean;
	/** Stringly-typed because cloudflared accepts duration strings like "30s". */
	connect_timeout?: string;
	tls_timeout?: string;
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

/** Atomic write — temp + rename. Returns the path written. */
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
 * Read the currently-rendered config.yml from disk. Used by the UI's
 * config inspector — gives the user "what cloudflared sees right now"
 * without having to exec into the container.
 */
export async function readCurrentConfig(): Promise<string> {
	const { readFile } = await import('node:fs/promises');
	const outPath = dataPath('cloudflared', 'config.yml');
	try {
		return await readFile(outPath, 'utf8');
	} catch (err) {
		return `# config.yml not yet written\n# error: ${(err as Error).message}\n`;
	}
}

/**
 * Build the render context for a given tunnel by pulling its enabled http(s)
 * hosts from DB. Non-HTTP hosts are routed via a different provider and
 * never appear in cloudflared's config.
 */
export async function buildContext(tunnelRow: {
	id: number;
	tunnel_id: string;
	credentials_path: string;
}): Promise<RenderContext> {
	const knex = getDb();
	type HostRow = {
		id: number;
		hostname: string;
		enabled: number;
		mode: string;
		path_prefix: string;
		forward_scheme: string;
		forward_host: string;
		forward_port: number;
		tls_options: string;
		advanced_options: string | null;
		protocol: string | null;
	};

	// advanced_options column was added in migration 006 and may not exist
	// yet on installs that paused mid-migration.
	const hasAdvanced = await knex.schema.hasColumn('proxy_hosts', 'advanced_options');
	const hasProtocol = await knex.schema.hasColumn('proxy_hosts', 'protocol');
	const cols: Array<keyof HostRow> = [
		'id',
		'hostname',
		'enabled',
		'mode',
		'path_prefix',
		'forward_scheme',
		'forward_host',
		'forward_port',
		'tls_options',
	];
	if (hasProtocol) cols.push('protocol');
	if (hasAdvanced) cols.push('advanced_options');

	// We fetch ALL rows attached to the tunnel, then filter in JS so we can
	// log WHY each one was excluded. "Live and running but page not found"
	// is overwhelmingly caused by silently-dropped ingress entries; the
	// per-row reason makes the diagnostic obvious.
	const allRows = await knex<HostRow>('proxy_hosts')
		.where({ tunnel_id: tunnelRow.id })
		.select(...cols);

	const included: HostRow[] = [];
	const excluded: Array<{ id: number; hostname: string; reason: string }> = [];
	for (const r of allRows) {
		if (r.mode !== 'cloudflare_tunnel') {
			excluded.push({ id: r.id, hostname: r.hostname, reason: `mode='${r.mode}' (not cloudflare_tunnel)` });
			continue;
		}
		if (Number(r.enabled) !== 1) {
			excluded.push({ id: r.id, hostname: r.hostname, reason: 'disabled' });
			continue;
		}
		// Treat NULL protocol as 'http' — defensive against partial migrations.
		const effectiveProtocol = r.protocol ?? 'http';
		if (effectiveProtocol !== 'http' && effectiveProtocol !== 'https') {
			excluded.push({
				id: r.id,
				hostname: r.hostname,
				reason: `protocol='${effectiveProtocol}' (not http/https — routed via different provider)`,
			});
			continue;
		}
		included.push(r);
	}

	if (excluded.length > 0) {
		log.warn(
			{ tunnel_id: tunnelRow.id, excluded, included_count: included.length },
			'buildContext: some hosts excluded from ingress'
		);
	}
	log.info(
		{ tunnel_id: tunnelRow.id, included: included.length, excluded: excluded.length },
		'buildContext: hosts evaluated for tunnel'
	);
	const rows = included;

	const hosts: RenderHost[] = [];
	for (const r of rows) {
		// Skip rows with corrupt forward_port / forward_host so a single bad
		// host can't break the whole tunnel's ingress.
		if (!r.forward_host || !Number.isFinite(r.forward_port) || r.forward_port < 1 || r.forward_port > 65535) {
			log.warn(
				{ hostname: r.hostname, forward_host: r.forward_host, forward_port: r.forward_port },
				'skipping host with invalid forward target'
			);
			continue;
		}

		let tls: { no_tls_verify?: boolean } = {};
		try {
			tls = typeof r.tls_options === 'string' ? JSON.parse(r.tls_options) : (r.tls_options ?? {});
		} catch {
			tls = {};
		}

		let adv: {
			http_host_header?: string;
			origin_server_name?: string;
			no_happy_eyeballs?: boolean;
			http2_origin?: boolean;
			disable_chunked_encoding?: boolean;
			connect_timeout_seconds?: number;
			tls_timeout_seconds?: number;
		} = {};
		try {
			adv =
				typeof r.advanced_options === 'string' && r.advanced_options.length > 0
					? JSON.parse(r.advanced_options)
					: {};
		} catch {
			adv = {};
		}

		const noTlsVerify = Boolean(tls.no_tls_verify);
		const hasOriginRequest =
			noTlsVerify ||
			!!adv.http_host_header ||
			!!adv.origin_server_name ||
			!!adv.no_happy_eyeballs ||
			!!adv.http2_origin ||
			!!adv.disable_chunked_encoding ||
			!!adv.connect_timeout_seconds ||
			!!adv.tls_timeout_seconds;

		hosts.push({
			hostname: r.hostname,
			path_prefix: r.path_prefix,
			forward_scheme: r.forward_scheme,
			forward_host: r.forward_host,
			forward_port: r.forward_port,
			no_tls_verify: noTlsVerify,
			has_origin_request: hasOriginRequest,
			http_host_header: adv.http_host_header,
			origin_server_name: adv.origin_server_name,
			no_happy_eyeballs: adv.no_happy_eyeballs,
			http2_origin: adv.http2_origin,
			disable_chunked_encoding: adv.disable_chunked_encoding,
			connect_timeout: adv.connect_timeout_seconds ? `${adv.connect_timeout_seconds}s` : undefined,
			tls_timeout: adv.tls_timeout_seconds ? `${adv.tls_timeout_seconds}s` : undefined,
		});
	}

	return {
		tunnel_id: tunnelRow.tunnel_id,
		credentials_path: tunnelRow.credentials_path,
		metrics_addr: '127.0.0.1:36500',
		hosts,
	};
}
