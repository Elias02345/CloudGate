/**
 * Cloudflare account API hooks (TanStack Query).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloudflareAccount, CloudflareZone } from '@cloudgate/shared';
import { api } from './client.js';

export function useCloudflareAccounts() {
	return useQuery<{ accounts: CloudflareAccount[] }>({
		queryKey: ['cloudflare', 'accounts'],
		queryFn: () => api('/cloudflare/accounts'),
	});
}

export function useAddCloudflareAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: { label: string; api_token: string }) => {
			return api<{ account: CloudflareAccount }>('/cloudflare/accounts', {
				method: 'POST',
				body: input,
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['cloudflare'] });
		},
	});
}

export function useDeleteCloudflareAccount() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number) => {
			await api<void>(`/cloudflare/accounts/${id}`, { method: 'DELETE' });
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['cloudflare'] });
		},
	});
}

export function useSyncZones(accountId: number | null) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			if (!accountId) throw new Error('No account selected');
			return api<{ count: number }>(`/cloudflare/accounts/${accountId}/sync`, { method: 'POST' });
		},
		onSuccess: () => {
			if (accountId) qc.invalidateQueries({ queryKey: ['cloudflare', 'zones', accountId] });
		},
	});
}

export function useZones(accountId: number | null) {
	return useQuery<{ zones: CloudflareZone[] }>({
		queryKey: ['cloudflare', 'zones', accountId],
		queryFn: () => {
			if (!accountId) return Promise.resolve({ zones: [] });
			return api(`/cloudflare/accounts/${accountId}/zones`);
		},
		enabled: accountId !== null,
	});
}
