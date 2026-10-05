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

export function useStartPlayitClaim() {
	return useMutation({
		mutationFn: () => api<{ code: string; url: string }>('/playit/claim', { method: 'POST' }),
	});
}

export type PlayitClaimResult =
	| { status: 'waiting_for_visit' | 'waiting_for_approval' }
	| { status: 'linked'; account: PlayitAccount };

/** One poll step of a claim; the caller loops until 'linked' or an error (400 rejected, 404 expired). */
export function usePollPlayitClaim() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { code: string; label?: string }) =>
			api<PlayitClaimResult>(`/playit/claim/${encodeURIComponent(input.code)}`, {
				method: 'POST',
				body: { label: input.label },
			}),
		onSuccess: (r) => {
			if (r.status === 'linked') qc.invalidateQueries({ queryKey: ['playit'] });
		},
	});
}

export function useDeletePlayitAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number) => {
			await api<void>(`/playit/accounts/${id}`, { method: 'DELETE' });
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['playit'] });
			// Unlinking removes the account's tunnels, which leaves the hosts
			// routed through them without one.
			qc.invalidateQueries({ queryKey: ['tunnels'] });
			qc.invalidateQueries({ queryKey: ['hosts'] });
		},
	});
}

export function usePlayitQuota(accountId: number | null) {
	return useQuery<{ quota: PlayitQuota }>({
		queryKey: ['playit', 'quota', accountId],
		queryFn: () => {
			if (!accountId)
				return Promise.resolve({ quota: { tcp_used: 0, udp_used: 0, tcp_limit: 0, udp_limit: 0 } });
			return api(`/playit/accounts/${accountId}/quota`);
		},
		enabled: accountId !== null,
	});
}
