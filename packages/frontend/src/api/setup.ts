/**
 * First-run setup API hooks (TanStack Query). See routes/setup.ts on the
 * backend: GET /status is public and cheap to poll, POST / creates the
 * one-and-only admin and logs it in (same response shape as /auth/login).
 */

import type { LoginResponse, SetupRequest, SetupStatusResponse } from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setStoredToken } from './client.js';

export function useSetupStatus() {
	return useQuery<SetupStatusResponse>({
		queryKey: ['setup', 'status'],
		queryFn: () => api('/setup/status'),
		retry: 0,
		// Checked pre-auth on every route change — short staleTime so a closing
		// window or a setup completed in another tab is noticed reasonably fast.
		staleTime: 15_000,
	});
}

export function useSetup() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: SetupRequest): Promise<LoginResponse> => {
			return api<LoginResponse>('/setup', { method: 'POST', body: input });
		},
		onSuccess: (data) => {
			setStoredToken(data.access_token);
			qc.invalidateQueries({ queryKey: ['auth', 'me'] });
			qc.invalidateQueries({ queryKey: ['setup', 'status'] });
		},
	});
}
