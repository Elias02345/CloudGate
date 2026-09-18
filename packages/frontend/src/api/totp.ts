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
		// Turning 2FA off costs the same as turning it on: password + a live code.
		mutationFn: (input: { password: string; code: string }) =>
			api<{ ok: true }>('/totp/disable', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
	});
}
