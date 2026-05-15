import { z } from 'zod';

export const HostModeSchema = z.enum(['cloudflare_tunnel', 'local_nginx']);
export type HostMode = z.infer<typeof HostModeSchema>;

export const ForwardSchemeSchema = z.enum(['http', 'https']);
export type ForwardScheme = z.infer<typeof ForwardSchemeSchema>;

const HostnameRegex = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

export const ProxyHostSchema = z.object({
	id: z.number().int().positive(),
	tunnel_id: z.number().int().positive().nullable(),
	cf_zone_id: z.number().int().positive().nullable(),
	mode: HostModeSchema,
	hostname: z.string().regex(HostnameRegex),
	forward_scheme: ForwardSchemeSchema,
	forward_host: z.string().min(1),
	forward_port: z.number().int().min(1).max(65535),
	path_prefix: z.string().default('/'),
	enabled: z.boolean(),
	dns_record_id: z.string().nullable(),
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
	hostname: z.string().regex(HostnameRegex),
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
