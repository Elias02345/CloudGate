import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface HostDto {
	id: number;
	tunnel_id: number | null;
	cf_zone_id: number | null;
	mode: 'cloudflare_tunnel' | 'local_nginx';
	hostname: string;
	forward_scheme: 'http' | 'https';
	forward_host: string;
	forward_port: number;
	path_prefix: string;
	enabled: boolean;
	tls_options: { no_tls_verify?: boolean };
	last_deployed_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateHostInput {
	mode: 'cloudflare_tunnel' | 'local_nginx';
	hostname: string;
	forward_scheme: 'http' | 'https';
	forward_host: string;
	forward_port: number;
	path_prefix?: string;
	tunnel_id?: number;
	cf_zone_id?: number;
	tls_options?: { no_tls_verify?: boolean };
}

export function useHosts() {
	return useQuery<{ hosts: HostDto[] }>({
		queryKey: ['hosts'],
		queryFn: () => api('/hosts'),
		refetchInterval: 10_000,
	});
}

export function useCreateHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateHostInput) => api<{ host: HostDto }>('/hosts', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
	});
}

export function useDeleteHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<void>(`/hosts/${id}`, { method: 'DELETE' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
	});
}

export function useToggleHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<{ enabled: boolean }>(`/hosts/${id}/toggle`, { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
	});
}

export function useTestHost() {
	return useMutation({
		mutationFn: (id: number) => api<{ ok?: boolean; status?: number; reachable?: false; error?: string }>(`/hosts/${id}/test`),
	});
}

export function useRedeployHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: number) => api<{ ok: true }>(`/hosts/${id}/redeploy`, { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
		onError: () => qc.invalidateQueries({ queryKey: ['hosts'] }), // refresh so user sees new last_error
	});
}

export interface UpdateHostInput {
	forward_scheme?: 'http' | 'https';
	forward_host?: string;
	forward_port?: number;
	path_prefix?: string;
	tls_options?: { no_tls_verify?: boolean };
	headers?: Record<string, string>;
}

export function useUpdateHost() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (args: { id: number; input: UpdateHostInput }) =>
			api<{ host: HostDto }>(`/hosts/${args.id}`, { method: 'PUT', body: args.input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
	});
}

export interface DnsVerifyResponse {
	hostname: string;
	expected: string;
	result:
		| { kind: 'ok'; cname: string; ttl: number; latency_ms: number }
		| { kind: 'wrong_target'; expected: string; got: string }
		| { kind: 'no_record'; message: string }
		| { kind: 'nxdomain'; message: string }
		| { kind: 'timeout'; message: string }
		| { kind: 'error'; message: string };
}

export function useVerifyDns() {
	return useMutation({
		mutationFn: (id: number) => api<DnsVerifyResponse>(`/hosts/${id}/verify-dns`),
	});
}
