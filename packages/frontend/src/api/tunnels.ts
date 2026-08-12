import type { TunnelProviderName } from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface TunnelDto {
	id: number;
	provider: TunnelProviderName;
	cloudflare_account_id: number | null;
	playit_account_id: number | null;
	tunnel_id: string;
	name: string;
	account_tag: string | null;
	status: string;
	live_status: string;
	last_status_at: string | null;
	created_at: string;
	/** Optional — populated by the backend when a provider error has been recorded. */
	last_error?: string | null;
	recovery_needed?: boolean;
}

export function useTunnels() {
	return useQuery<{ tunnels: TunnelDto[] }>({
		queryKey: ['tunnels'],
		queryFn: () => api('/tunnels'),
		refetchInterval: 5_000,
	});
}

export interface CreateTunnelInput {
	provider?: TunnelProviderName;
	cloudflare_account_id?: number;
	playit_account_id?: number;
	name: string;
}

export function useCreateTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateTunnelInput) =>
			api<{ tunnel: TunnelDto }>('/tunnels', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnels'] }),
	});
}

export interface RecreateTunnelResult {
	ok: true;
	old_uuid: string;
	new_uuid: string;
	hosts_total: number;
	hosts_redeployed: number;
	host_errors: Array<{ hostname: string; error: string }>;
}

export function useRecreateTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<RecreateTunnelResult>(`/tunnels/${id}/recreate`, { method: 'POST' }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['tunnels'] });
			qc.invalidateQueries({ queryKey: ['hosts'] });
		},
	});
}

export interface ForceSyncResult {
	ok: true;
	hosts_total: number;
	hosts_redeployed: number;
	host_errors: Array<{ hostname: string; error: string }>;
}

export function useForceSyncTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<ForceSyncResult>(`/tunnels/${id}/force-sync`, { method: 'POST' }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['tunnels'] });
			qc.invalidateQueries({ queryKey: ['hosts'] });
		},
	});
}

export function useDeleteTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<void>(`/tunnels/${id}`, { method: 'DELETE' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnels'] }),
	});
}

export function useRestartTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<{ ok: true }>(`/tunnels/${id}/restart`, { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnels'] }),
	});
}

export function useTunnelLogs(id: number | null) {
	return useQuery<{ logs: string[] }>({
		queryKey: ['tunnels', 'logs', id],
		queryFn: () => api(`/tunnels/${id}/logs`),
		enabled: id !== null,
		refetchInterval: id !== null ? 3_000 : false,
	});
}

export interface TunnelConfigResponse {
	tunnel: { id: number; tunnel_id: string; name: string; provider: TunnelProviderName };
	hosts: Array<{
		id: number;
		hostname: string;
		protocol?: string;
		forward_scheme: string;
		forward_host: string;
		forward_port: number;
		enabled: boolean | number;
		edge_endpoint?: unknown;
		last_deployed_at: string | null;
		last_error: string | null;
	}>;
	yaml?: string;
	provider_meta?: unknown;
}

export function useTunnelConfig(id: number | null) {
	return useQuery<TunnelConfigResponse>({
		queryKey: ['tunnels', 'config', id],
		queryFn: () => api(`/tunnels/${id}/config`),
		enabled: id !== null,
	});
}

export function useRedeployAllHosts() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) =>
			api<{ ok: number; failed: number; errors: Array<{ hostname: string; error: string }> }>(
				`/tunnels/${id}/redeploy-all`,
				{ method: 'POST' }
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['hosts'] });
			qc.invalidateQueries({ queryKey: ['tunnels'] });
		},
	});
}
