/**
 * Auth API hooks (TanStack Query).
 */

import type {
	ChangePasswordRequest,
	LoginRequest,
	LoginResponse,
	MeResponse,
	PatchUserFlagsRequest,
	UserFlags,
} from '@cloudgate/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setStoredToken } from './client.js';

export function useLogin() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: LoginRequest): Promise<LoginResponse> => {
			return api<LoginResponse>('/auth/login', { method: 'POST', body: input });
		},
		onSuccess: (data) => {
			setStoredToken(data.access_token);
			// Force a refetch so we get the full {user, flags} shape from /me
			qc.invalidateQueries({ queryKey: ['auth', 'me'] });
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
	return useQuery<MeResponse | null>({
		queryKey: ['auth', 'me'],
		queryFn: async () => {
			try {
				return await api<MeResponse>('/auth/me');
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

export function usePatchUserFlags() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: PatchUserFlagsRequest): Promise<UserFlags> => {
			const res = await api<{ flags: UserFlags }>('/auth/me/flags', { method: 'PATCH', body: input });
			return res.flags;
		},
		onSuccess: (flags) => {
			qc.setQueryData<MeResponse | null>(['auth', 'me'], (prev) => (prev ? { ...prev, flags } : prev));
		},
	});
}
