import { z } from 'zod';

export const ApiKeyScopeSchema = z.enum(['read', 'admin']);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeySchema = z.object({
	id: z.number().int().positive(),
	name: z.string().min(1).max(80),
	prefix: z.string(),
	scope: ApiKeyScopeSchema,
	last_used_at: z.string().datetime().nullable(),
	last_used_ip: z.string().nullable(),
	expires_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyRequestSchema = z.object({
	name: z.string().min(1).max(80),
	scope: ApiKeyScopeSchema.default('admin'),
	expires_at: z.string().datetime().nullable().optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const CreateApiKeyResponseSchema = z.object({
	key: ApiKeySchema,
	/** Full plaintext key — only present in the create-response, shown once. */
	plaintext: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;

export const ListApiKeysResponseSchema = z.object({ keys: z.array(ApiKeySchema) });
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponseSchema>;
