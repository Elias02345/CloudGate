import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface TunnelDto {
	id: number;
	cloudflare_account_id: number;
	tunnel_id: string;
	name: string;
	account_tag: string;
	status: string;
	live_status: string;
	last_status_at: string | null;
	created_at: string;
}

export function useTunnels() {
	return useQuery<{ tunnels: TunnelDto[] }>({
		queryKey: ['tunnels'],
		queryFn: () => api('/tunnels'),
		refetchInterval: 5_000,
	});
}

export function useCreateTunnel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { cloudflare_account_id: number; name: string }) =>
			api<{ tunnel: TunnelDto }>('/tunnels', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnels'] }),
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
	tunnel: { id: number; tunnel_id: string; name: string };
	hosts: Array<{
		id: number;
		hostname: string;
		forward_scheme: string;
		forward_host: string;
		forward_port: number;
		enabled: boolean | number;
		last_deployed_at: string | null;
		last_error: string | null;
	}>;
	yaml: string;
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
				{ method: 'POST' },
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['hosts'] });
			qc.invalidateQueries({ queryKey: ['tunnels'] });
		},
	});
}
