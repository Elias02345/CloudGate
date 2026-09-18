import { z } from 'zod';

export const HostModeSchema = z.enum(['cloudflare_tunnel', 'local_nginx']);
export type HostMode = z.infer<typeof HostModeSchema>;

export const ForwardSchemeSchema = z.enum(['http', 'https']);
export type ForwardScheme = z.infer<typeof ForwardSchemeSchema>;

/**
 * Transport protocol exposed at the edge.
 * - `http`/`https` go through cloudflared as HTTP ingress (existing behaviour).
 * - `tcp`/`udp` go through a non-HTTP provider (Playit) and produce an SRV
 *   record or a bare host:port endpoint depending on what the client needs.
 */
export const HostProtocolSchema = z.enum(['http', 'https', 'tcp', 'udp']);
export type HostProtocol = z.infer<typeof HostProtocolSchema>;

/**
 * UI-side preset that maps to (protocol, provider, default_port,
 * srv_service). Kept here so the frontend and backend agree on the wire
 * value.
 */
export const HostTypeSchema = z.enum(['web', 'minecraft_java', 'minecraft_bedrock', 'raw_tcp', 'raw_udp']);
export type HostType = z.infer<typeof HostTypeSchema>;

/** Edge endpoint shape returned by a tunnel provider after addHost(). */
export const ProviderEdgeEndpointSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('cname'),
		target: z.string(),
	}),
	z.object({
		kind: z.literal('srv'),
		target: z.string(),
		port: z.number().int().min(1).max(65535),
		service: z.string(), // e.g. '_minecraft'
		proto: z.enum(['_tcp', '_udp']),
	}),
	z.object({
		kind: z.literal('host_port'),
		target: z.string(),
		port: z.number().int().min(1).max(65535),
	}),
]);
export type ProviderEdgeEndpoint = z.infer<typeof ProviderEdgeEndpointSchema>;

const HostnameRegex = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

/**
 * A hostname with no dot in it: `localhost`, `jellyfin`, `my-nas`.
 *
 * `HostnameRegex` above requires at least one dot because it validates the
 * public hostnames CloudGate serves. An *origin* is usually the opposite —
 * a Docker service name, a container alias, or plain `localhost` — so
 * demanding a dot there would reject the most common homelab setup there is.
 * The characters are what matter for safety, not the dot.
 */
const SingleLabelHostRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$/;

/** Dotted-quad IPv4 literal, each octet 0-255. */
const Ipv4Regex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Full or compressed IPv6 literal (no zone id, no IPv4-mapped form — a
 * forward_host doesn't need those for a homelab/VPS origin).
 */
const Ipv6Regex =
	/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

/**
 * forward_host lands raw in an nginx `upstream … { server … }` directive and
 * a cloudflared `service:` URL (see nginx-config.ts / config-writer.ts) —
 * nginx has no escaping for directive arguments, so only a hostname or an
 * IP literal may pass. Anything else (spaces, `;`, `{`, `}`) can terminate
 * the directive and inject config.
 */
export function isValidForwardHost(value: string): boolean {
	return (
		HostnameRegex.test(value) ||
		SingleLabelHostRegex.test(value) ||
		Ipv4Regex.test(value) ||
		Ipv6Regex.test(value)
	);
}

/**
 * path_prefix lands raw in `location {{ path_prefix }} {` — must start with
 * `/` and stay within characters that can't terminate the directive or open
 * a new block: no whitespace/newlines, braces, semicolons, quotes, or
 * backslashes.
 */
export const PathPrefixRegex = /^\/[^\s{};"'\\]*$/;

/**
 * Per-host originRequest tuning — surfaces the most common cloudflared
 * knobs real-world apps need. Stored as JSON in proxy_hosts.advanced_options.
 *
 * Naming kept snake_case at the API boundary; mapped to cloudflared's
 * camelCase originRequest keys at config-render time.
 */
/**
 * How the proxy should populate `X-Forwarded-*` towards the origin.
 *
 * Only honoured in `local_nginx` mode — in `cloudflare_tunnel` mode the
 * Cloudflare edge adds `X-Forwarded-For` before cloudflared ever sees the
 * request and cloudflared has no header-rewriting knob, so nothing we
 * render into config.yml can change what the origin receives.
 *
 * - `standard`        — append our hop to the incoming chain
 *                       (`$proxy_add_x_forwarded_for`). Default; preserves
 *                       the real client IP.
 * - `client_ip_only`  — send exactly one entry, the peer we received the
 *                       request from. Fixes origins that choke on multi-hop
 *                       chains while keeping a usable client IP.
 * - `strip`           — send no `X-Forwarded-*` at all. Last resort for
 *                       origins that reject proxied requests outright
 *                       (Home Assistant without `trusted_proxies`).
 *                       WARNING: the origin then sees every visitor as
 *                       CloudGate's IP, which defeats per-client rate
 *                       limiting and brute-force banning on the origin.
 */
export const ForwardedHeaderModeSchema = z.enum(['standard', 'client_ip_only', 'strip']);
export type ForwardedHeaderMode = z.infer<typeof ForwardedHeaderModeSchema>;

export const HostAdvancedOptionsSchema = z.object({
	/**
	 * Override the Host header sent to the origin.
	 *
	 * NOTE: this does NOT fix Home Assistant's "400 Bad Request". That check
	 * is `use_x_forwarded_for` / `trusted_proxies` in HA's
	 * `homeassistant/components/http/forwarded.py` and inspects the TCP peer
	 * plus `X-Forwarded-For` — never the Host header. See
	 * docs/HOME-ASSISTANT.md.
	 */
	http_host_header: z.string().optional(),
	/** See {@link ForwardedHeaderModeSchema}. `local_nginx` mode only. */
	forwarded_headers: ForwardedHeaderModeSchema.optional(),
	/** SNI value for TLS to origin. Only meaningful when forward_scheme=https. */
	origin_server_name: z.string().optional(),
	/** Disable HappyEyeballs (IPv6 fallback) — set if your origin is IPv4-only. */
	no_happy_eyeballs: z.boolean().optional(),
	/** Force HTTP/2 to origin. Speeds up apps that support it. */
	http2_origin: z.boolean().optional(),
	/** Required for some old HTTP/1.0 origins that mishandle chunked encoding. */
	disable_chunked_encoding: z.boolean().optional(),
	/** TCP connect timeout in seconds. Default cloudflared is 30. */
	connect_timeout_seconds: z.number().int().min(1).max(600).optional(),
	/** TLS handshake timeout in seconds. */
	tls_timeout_seconds: z.number().int().min(1).max(600).optional(),
});
export type HostAdvancedOptions = z.infer<typeof HostAdvancedOptionsSchema>;

export const ProxyHostSchema = z.object({
	id: z.number().int().positive(),
	tunnel_id: z.number().int().positive().nullable(),
	cf_zone_id: z.number().int().positive().nullable(),
	mode: HostModeSchema,
	protocol: HostProtocolSchema.default('http'),
	hostname: z.string().regex(HostnameRegex),
	forward_scheme: ForwardSchemeSchema,
	forward_host: z.string().min(1).refine(isValidForwardHost, {
		message: 'forward_host must be a valid hostname, IPv4 address, or IPv6 address',
	}),
	forward_port: z.number().int().min(1).max(65535),
	path_prefix: z
		.string()
		.regex(PathPrefixRegex, {
			message:
				'path_prefix must start with / and must not contain whitespace, braces, semicolons, quotes, or backslashes',
		})
		.default('/'),
	enabled: z.boolean(),
	dns_record_id: z.string().nullable(),
	edge_endpoint: ProviderEdgeEndpointSchema.nullable().optional(),
	tls_options: z
		.object({
			no_tls_verify: z.boolean().default(false),
			origin_cert: z.string().optional(),
		})
		.default({}),
	advanced_options: HostAdvancedOptionsSchema.default({}),
	headers: z.record(z.string(), z.string()).default({}),
	meta: z.record(z.string(), z.unknown()).default({}),
	last_deployed_at: z.string().datetime().nullable(),
	last_error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type ProxyHost = z.infer<typeof ProxyHostSchema>;

export const CreateProxyHostRequestSchema = z.object({
	mode: HostModeSchema,
	protocol: HostProtocolSchema.default('http'),
	hostname: z.string().regex(HostnameRegex),
	// forward_scheme is HTTP-only; kept for back-compat. TCP/UDP hosts
	// just ignore it (route validation enforces the constraint).
	forward_scheme: ForwardSchemeSchema.default('http'),
	forward_host: z.string().min(1).refine(isValidForwardHost, {
		message: 'forward_host must be a valid hostname, IPv4 address, or IPv6 address',
	}),
	forward_port: z.coerce.number().int().min(1).max(65535),
	path_prefix: z
		.string()
		.regex(PathPrefixRegex, {
			message:
				'path_prefix must start with / and must not contain whitespace, braces, semicolons, quotes, or backslashes',
		})
		.default('/'),
	tunnel_id: z.number().int().positive().optional(),
	cf_zone_id: z.number().int().positive().optional(),
	tls_options: z
		.object({
			no_tls_verify: z.boolean().default(false),
		})
		.default({}),
	advanced_options: HostAdvancedOptionsSchema.default({}),
	headers: z.record(z.string(), z.string()).default({}),
});
export type CreateProxyHostRequest = z.infer<typeof CreateProxyHostRequestSchema>;
