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
 * Per-host originRequest tuning — surfaces the most common cloudflared
 * knobs real-world apps need. Stored as JSON in proxy_hosts.advanced_options.
 *
 * Naming kept snake_case at the API boundary; mapped to cloudflared's
 * camelCase originRequest keys at config-render time.
 */
export const HostAdvancedOptionsSchema = z.object({
	/** Override Host header sent to origin. Fixes "Bad Request" from apps
	 * that check `trusted_proxies` (HomeAssistant, some Django setups). */
	http_host_header: z.string().optional(),
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
	forward_host: z.string().min(1),
	forward_port: z.number().int().min(1).max(65535),
	path_prefix: z.string().default('/'),
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
	forward_host: z.string().min(1),
	forward_port: z.coerce.number().int().min(1).max(65535),
	path_prefix: z.string().default('/'),
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
