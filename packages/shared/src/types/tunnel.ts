import { z } from 'zod';

export const TunnelStatusSchema = z.enum(['starting', 'running', 'stopped', 'error']);
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

/**
 * Which backing service hosts the tunnel. Drives provider-dispatch in
 * the backend. Extend this enum (and add a TunnelProvider implementation)
 * when integrating a new provider.
 */
export const TunnelProviderSchema = z.enum(['cloudflared', 'playit']);
export type TunnelProviderName = z.infer<typeof TunnelProviderSchema>;

export const TunnelSchema = z.object({
	id: z.number().int().positive(),
	provider: TunnelProviderSchema.default('cloudflared'),
	// CF-specific — null for non-cloudflared providers
	cloudflare_account_id: z.number().int().positive().nullable(),
	// CF tunnels expose a UUID here; Playit tunnels may use a non-UUID id
	tunnel_id: z.string(),
	name: z.string(),
	account_tag: z.string().nullable(),
	status: TunnelStatusSchema,
	last_status_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});
export type Tunnel = z.infer<typeof TunnelSchema>;

/**
 * Discriminated by `provider`. cloudflared requires `cloudflare_account_id`;
 * playit requires `playit_account_id`. Routes validate the appropriate id is
 * present per provider.
 */
export const CreateTunnelRequestSchema = z
	.object({
		provider: TunnelProviderSchema.default('cloudflared'),
		cloudflare_account_id: z.number().int().positive().optional(),
		playit_account_id: z.number().int().positive().optional(),
		name: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[a-zA-Z0-9-_]+$/),
	})
	.refine(
		(v) => {
			if (v.provider === 'cloudflared') return v.cloudflare_account_id !== undefined;
			if (v.provider === 'playit') return v.playit_account_id !== undefined;
			return false;
		},
		{
			message: 'cloudflared tunnels require cloudflare_account_id; playit tunnels require playit_account_id',
		}
	);
export type CreateTunnelRequest = z.infer<typeof CreateTunnelRequestSchema>;

/**
 * Global cloudflared network settings (settings table keys
 * `cloudflared.protocol` / `cloudflared.edge_ip_version`).
 * 'auto' = cloudflared's own QUIC-then-HTTP/2 choice, plus CloudGate's
 * HTTP/2 fallback when QUIC never connects (VPN / firewall).
 */
export const CloudflaredProtocolSchema = z.enum(['auto', 'http2', 'quic']);
export const CloudflaredEdgeIpVersionSchema = z.enum(['4', '6', 'auto']);
export const CloudflaredNetworkSettingsSchema = z.object({
	protocol: CloudflaredProtocolSchema,
	edge_ip_version: CloudflaredEdgeIpVersionSchema,
});
export type CloudflaredNetworkSettings = z.infer<typeof CloudflaredNetworkSettingsSchema>;
export const UpdateCloudflaredNetworkSettingsSchema = CloudflaredNetworkSettingsSchema.partial();
