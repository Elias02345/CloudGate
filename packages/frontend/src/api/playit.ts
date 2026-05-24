/**
 * Playit.gg account API hooks (TanStack Query).
 */

import type { PlayitAccount, PlayitQuota } from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function usePlayitAccounts() {
	return useQuery<{ accounts: PlayitAccount[] }>({
		queryKey: ['playit', 'accounts'],
		queryFn: () => api('/playit/accounts'),
	});
}

export function useAddPlayitAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: { label: string; secret_key: string }) => {
			return api<{ account: PlayitAccount }>('/playit/accounts', { method: 'POST', body: input });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ['playit'] }),
	});
}

export function useDeletePlayitAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number) => {
			await api<void>(`/playit/accounts/${id}`, { method: 'DELETE' });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ['playit'] }),
	});
}

export function usePlayitQuota(accountId: number | null) {
	return useQuery<{ quota: PlayitQuota }>({
		queryKey: ['playit', 'quota', accountId],
		queryFn: () => {
			if (!accountId)
				return Promise.resolve({ quota: { tcp_used: 0, udp_used: 0, tcp_limit: 4, udp_limit: 4 } });
			return api(`/playit/accounts/${accountId}/quota`);
		},
		enabled: accountId !== null,
	});
}
