import { z } from 'zod';

export const TunnelStatusSchema = z.enum(['starting', 'running', 'stopped', 'error']);
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export const TunnelSchema = z.object({
	id: z.number().int().positive(),
	cloudflare_account_id: z.number().int().positive(),
	tunnel_id: z.string().uuid(),
	name: z.string(),
	account_tag: z.string(),
	status: TunnelStatusSchema,
	last_status_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});
export type Tunnel = z.infer<typeof TunnelSchema>;

export const CreateTunnelRequestSchema = z.object({
	cloudflare_account_id: z.number().int().positive(),
	name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9-_]+$/),
});
export type CreateTunnelRequest = z.infer<typeof CreateTunnelRequestSchema>;
