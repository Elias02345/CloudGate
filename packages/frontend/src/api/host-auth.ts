import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export type HostAuthState = { enabled: false } | { enabled: true; username: string; totp_enabled: boolean };

export interface SaveHostAuthInput {
	username: string;
	password?: string;
	/** Enable with a verified secret/code, disable with null, leave unchanged when omitted. */
	totp?: { secret: string; code: string } | null;
}

export interface TotpSetup {
	secret: string;
	otpauth_url: string;
	qr_code_data_url: string;
}

export function useHostAuth(hostId: number | undefined, enabled: boolean) {
	return useQuery<HostAuthState>({
		queryKey: ['host-auth', hostId],
		queryFn: () => api(`/hosts/${hostId}/auth`),
		enabled: enabled && hostId !== undefined,
	});
}

export function useSaveHostAuth(hostId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: SaveHostAuthInput) =>
			api<HostAuthState & { deploy_error: string | null }>(`/hosts/${hostId}/auth`, {
				method: 'PUT',
				body: input,
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['host-auth', hostId] }),
	});
}

export function useRemoveHostAuth(hostId: number) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () =>
			api<{ enabled: false; deploy_error: string | null }>(`/hosts/${hostId}/auth`, { method: 'DELETE' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['host-auth', hostId] }),
	});
}

export function useTotpSetup(hostId: number) {
	return useMutation({
		mutationFn: () => api<TotpSetup>(`/hosts/${hostId}/auth/totp-setup`, { method: 'POST' }),
	});
}
