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
			// Changing the password revokes every token, this tab's included.
			// The response carries a replacement — store it or the next request
			// is a 401.
			const data = await api<{ ok: true; access_token?: string }>('/auth/password', {
				method: 'POST',
				body: input,
			});
			if (data.access_token) setStoredToken(data.access_token);
		},
		// Returned, not fired and forgotten: react-query awaits a promise from
		// onSuccess, so `mutateAsync` resolves only once /auth/me has actually
		// been refetched. Without that wait, the caller navigates away while
		// the cache still says must_change_password, ProtectedRoute bounces it
		// straight back to /password, and the user is stranded on the form they
		// just completed.
		onSuccess: () => qc.invalidateQueries({ queryKey: ['auth', 'me'] }),
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
