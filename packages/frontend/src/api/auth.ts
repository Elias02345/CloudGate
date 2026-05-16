/**
 * Auth API hooks (TanStack Query).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
	ChangePasswordRequest,
	LoginRequest,
	LoginResponse,
	User,
} from '@cloudgate/shared';
import { api, setStoredToken } from './client.js';

export function useLogin() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: LoginRequest): Promise<LoginResponse> => {
			return api<LoginResponse>('/auth/login', { method: 'POST', body: input });
		},
		onSuccess: (data) => {
			setStoredToken(data.access_token);
			qc.setQueryData(['auth', 'me'], { user: data.user });
		},
	});
}

export function useLogout() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (): Promise<void> => {
			try {
				await api<{ ok: true }>('/auth/logout', { method: 'POST' });
			} catch {
				/* even if server fails, drop the token client-side */
			}
		},
		onSettled: () => {
			setStoredToken(null);
			qc.removeQueries({ queryKey: ['auth'] });
			qc.clear();
		},
	});
}

export function useMe() {
	return useQuery<{ user: User } | null>({
		queryKey: ['auth', 'me'],
		queryFn: async () => {
			try {
				return await api<{ user: User }>('/auth/me');
			} catch (err) {
				if ((err as { status?: number }).status === 401) return null;
				throw err;
			}
		},
		staleTime: 60_000,
	});
}

export function useChangePassword() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: ChangePasswordRequest): Promise<void> => {
			await api<{ ok: true }>('/auth/password', { method: 'POST', body: input });
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['auth', 'me'] });
		},
	});
}
