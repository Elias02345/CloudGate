import { z } from 'zod';

export const LlmProviderSchema = z.enum(['anthropic', 'openai', 'custom']);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmAutonomySchema = z.enum(['off', 'suggest_only', 'autonomous']);
export type LlmAutonomy = z.infer<typeof LlmAutonomySchema>;

export const LlmSettingsSchema = z.object({
	provider: LlmProviderSchema.nullable(),
	model: z.string().min(1).max(120).nullable(),
	base_url: z.string().url().nullable(),
	has_api_key: z.boolean(),
	autonomy: LlmAutonomySchema,
	system_prompt_override: z.string().max(1500).nullable(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export const UpdateLlmSettingsRequestSchema = z.object({
	provider: LlmProviderSchema.optional(),
	model: z.string().min(1).max(120).optional(),
	base_url: z.string().url().nullable().optional(),
	/** Plaintext — encrypted server-side. Pass null to clear. */
	api_key: z.string().nullable().optional(),
	autonomy: LlmAutonomySchema.optional(),
	system_prompt_override: z.string().max(1500).nullable().optional(),
});
export type UpdateLlmSettingsRequest = z.infer<typeof UpdateLlmSettingsRequestSchema>;

export const AiChatMessageSchema = z.object({
	id: z.number().int(),
	role: z.enum(['user', 'assistant', 'tool']),
	content: z.string().nullable(),
	tool_calls: z.array(z.unknown()).nullable(),
	tool_results: z.array(z.unknown()).nullable(),
	created_at: z.string().datetime(),
});
export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;

export const AiConversationSchema = z.object({
	id: z.string(),
	title: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
export type AiConversation = z.infer<typeof AiConversationSchema>;

export const AiSendMessageRequestSchema = z.object({
	conversation_id: z.string().optional(),
	message: z.string().min(1).max(8000),
});
export type AiSendMessageRequest = z.infer<typeof AiSendMessageRequestSchema>;

export const AiConfirmActionRequestSchema = z.object({
	action_token: z.string().uuid(),
});
export type AiConfirmActionRequest = z.infer<typeof AiConfirmActionRequestSchema>;

export const AiTestRequestSchema = z.object({
	provider: LlmProviderSchema.optional(),
	model: z.string().optional(),
	base_url: z.string().url().nullable().optional(),
	api_key: z.string().optional(),
});
export type AiTestRequest = z.infer<typeof AiTestRequestSchema>;

export interface AiTestResponse {
	ok: boolean;
	latency_ms?: number;
	error?: string;
	model?: string;
}
