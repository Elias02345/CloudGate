import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface UpdateStatus {
	current_version: string;
	latest_version: string | null;
	update_available: boolean;
	state: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'rolling_back' | 'failed';
	last_checked_at: string | null;
	channel: 'stable' | 'prerelease' | 'nightly' | 'disabled';
	mode: 'auto' | 'notify' | 'scheduled';
	last_error: string | null;
	release_notes_url?: string | null;
}

export function useUpdateStatus() {
	return useQuery<UpdateStatus>({
		queryKey: ['updates'],
		queryFn: () => api('/updates'),
		refetchInterval: 30_000,
	});
}

export function useCheckUpdates() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api<UpdateStatus>('/updates/check', { method: 'POST' }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['updates'] }),
	});
}

export function useInstallUpdate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (version: string) =>
			api<{ ok: true; message: string }>('/updates/install', { method: 'POST', body: { version } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['updates'] }),
	});
}

export function useUpdateSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { channel: UpdateStatus['channel']; mode: UpdateStatus['mode'] }) =>
			api<UpdateStatus>('/updates/settings', { method: 'POST', body: input }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['updates'] }),
	});
}
