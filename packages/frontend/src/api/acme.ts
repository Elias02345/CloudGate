import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export function useIssueCert() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { hostname: string; staging?: boolean }) =>
			api<{ ok: true; expires_at: string }>('/acme/issue', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['hosts'] }),
	});
}
