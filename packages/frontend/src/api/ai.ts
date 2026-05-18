import type {
	AiConfirmActionRequest,
	AiConversation,
	AiSendMessageRequest,
	AiTestResponse,
	LlmSettings,
	UpdateLlmSettingsRequest,
} from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function useLlmSettings() {
	return useQuery<LlmSettings>({
		queryKey: ['llm', 'settings'],
		queryFn: () => api<LlmSettings>('/ai/settings'),
		staleTime: 30_000,
	});
}

export function useUpdateLlmSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: UpdateLlmSettingsRequest) =>
			api<LlmSettings>('/ai/settings', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['llm', 'settings'] }),
	});
}

export function useTestLlm() {
	return useMutation({
		mutationFn: (input: { provider?: string; model?: string; base_url?: string | null; api_key?: string }) =>
			api<AiTestResponse>('/ai/settings/test', { method: 'POST', body: input }),
	});
}

export interface ChatResponse {
	conversation_id: string;
	message: string;
	tool_results?: Array<{
		tool_call_id: string;
		name: string;
		result: unknown;
		pending?: { action_token: string; summary: string };
	}>;
}

export function useSendMessage() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: AiSendMessageRequest) =>
			api<ChatResponse>('/ai/chat', { method: 'POST', body: input }),
		onSuccess: (data) => {
			qc.invalidateQueries({ queryKey: ['ai', 'conversation', data.conversation_id] });
			qc.invalidateQueries({ queryKey: ['ai', 'conversations'] });
		},
	});
}

export function useConversations() {
	return useQuery<{ conversations: AiConversation[] }>({
		queryKey: ['ai', 'conversations'],
		queryFn: () => api<{ conversations: AiConversation[] }>('/ai/conversations'),
	});
}

interface ConversationDetail {
	conversation: AiConversation;
	messages: Array<{
		id: number;
		role: 'user' | 'assistant' | 'tool';
		content: string | null;
		tool_calls: unknown[] | null;
		tool_results: unknown[] | null;
		created_at: string;
	}>;
}

export function useConversation(id: string | null) {
	return useQuery<ConversationDetail>({
		queryKey: ['ai', 'conversation', id],
		queryFn: () => api<ConversationDetail>(`/ai/conversations/${id}`),
		enabled: !!id,
	});
}

export function useDeleteConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: string) => {
			await api<{ ok: true }>(`/ai/conversations/${id}`, { method: 'DELETE' });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ['ai', 'conversations'] }),
	});
}

export function useConfirmAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: AiConfirmActionRequest) =>
			api<{ ok: true; result: unknown }>('/ai/confirm-action', { method: 'POST', body: input }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['hosts'] });
			qc.invalidateQueries({ queryKey: ['tunnels'] });
		},
	});
}
