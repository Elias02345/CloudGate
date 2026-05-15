import { z } from 'zod';

export const CloudflareAuthTypeSchema = z.enum(['api_token', 'oauth']);
export type CloudflareAuthType = z.infer<typeof CloudflareAuthTypeSchema>;

export const CloudflareAccountSchema = z.object({
	id: z.number().int().positive(),
	label: z.string(),
	auth_type: CloudflareAuthTypeSchema,
	account_tag: z.string(),
	email: z.string().email().nullable(),
	last_validated_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});
export type CloudflareAccount = z.infer<typeof CloudflareAccountSchema>;

export const CreateCloudflareAccountRequestSchema = z.object({
	label: z.string().min(1).max(100),
	auth_type: CloudflareAuthTypeSchema,
	api_token: z.string().min(20).optional(),
});
export type CreateCloudflareAccountRequest = z.infer<typeof CreateCloudflareAccountRequestSchema>;

export const CloudflareZoneSchema = z.object({
	id: z.number().int().positive(),
	cloudflare_account_id: z.number().int().positive(),
	zone_id: z.string(),
	name: z.string(),
	status: z.string(),
	last_synced_at: z.string().datetime(),
});
export type CloudflareZone = z.infer<typeof CloudflareZoneSchema>;
