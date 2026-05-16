import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function useTotpSetup() {
	return useMutation({
		mutationFn: () =>
			api<{ secret: string; otpauth_url: string; qr_code_data_url: string }>('/totp/setup', {
				method: 'POST',
			}),
	});
}

export function useTotpEnable() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { secret: string; code: string }) =>
			api<{ ok: true }>('/totp/enable', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
	});
}

export function useTotpDisable() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (password: string) => api<{ ok: true }>('/totp/disable', { method: 'POST', body: { password } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
	});
}
