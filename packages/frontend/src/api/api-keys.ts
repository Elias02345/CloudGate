import type {
	ApiKey,
	CreateApiKeyRequest,
	CreateApiKeyResponse,
	ListApiKeysResponse,
} from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function useApiKeys() {
	return useQuery<ListApiKeysResponse>({
		queryKey: ['api-keys'],
		queryFn: () => api<ListApiKeysResponse>('/api-keys'),
	});
}

export function useCreateApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: CreateApiKeyRequest): Promise<CreateApiKeyResponse> =>
			api<CreateApiKeyResponse>('/api-keys', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
	});
}

export function useRevokeApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number): Promise<void> => {
			await api<{ ok: true }>(`/api-keys/${id}`, { method: 'DELETE' });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
	});
}

export function useRotateApiKey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number): Promise<CreateApiKeyResponse> =>
			api<CreateApiKeyResponse>(`/api-keys/${id}/rotate`, { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
	});
}

export type { ApiKey };
