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
export const HostTypeSchema = z.enum([
	'web',
	'minecraft_java',
	'minecraft_bedrock',
	'raw_tcp',
	'raw_udp',
]);
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
	headers: z.record(z.string(), z.string()).default({}),
});
export type CreateProxyHostRequest = z.infer<typeof CreateProxyHostRequestSchema>;
