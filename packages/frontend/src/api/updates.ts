import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export type UpdateStep =
	| 'acquire_lock'
	| 'download_archive'
	| 'download_sha'
	| 'download_sig'
	| 'verify_sha'
	| 'verify_gpg'
	| 'spawn_apply'
	| 'apply_running'
	| 'done'
	| 'failed';

export interface UpdateStatus {
	current_version: string;
	latest_version: string | null;
	update_available: boolean;
	state:
		| 'idle'
		| 'checking'
		| 'available'
		| 'downloading'
		| 'verifying'
		| 'installing'
		| 'rolling_back'
		| 'failed';
	last_checked_at: string | null;
	channel: 'stable' | 'prerelease' | 'nightly' | 'disabled';
	mode: 'auto' | 'notify' | 'scheduled';
	last_error: string | null;
	release_notes_url?: string | null;

	// Fine-grained install progress (only set during downloading/verifying/installing)
	step?: UpdateStep | null;
	step_label?: string | null;
	overall_progress?: number | null;
	download_bytes?: number | null;
	download_total?: number | null;
	started_at?: string | null;
	target_version?: string | null;
}

export interface UpdateLogResponse {
	lines: string[];
	byte_offset: number;
}

export interface LastUpdateMarker {
	from: string;
	to: string;
	outcome: 'succeeded' | 'failed' | 'rolled_back';
	reason: string;
	started_at: string;
}

export function useUpdateStatus(opts: { refetchInterval?: number | false } = {}) {
	return useQuery<UpdateStatus>({
		queryKey: ['updates'],
		queryFn: () => api('/updates'),
		refetchInterval: opts.refetchInterval ?? 30_000,
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

/**
 * One-shot fetch of the tail of /data/logs/update-history.log. Used after
 * the backend reconnects to surface the apply phase the user couldn't see
 * live (because the backend was down).
 */
export async function fetchUpdateLog(lines = 300): Promise<UpdateLogResponse> {
	return api<UpdateLogResponse>(`/updates/log?lines=${lines}`);
}

/**
 * Latest .last-update-*.json marker. 404 when no update has run yet.
 */
export async function fetchLastUpdate(): Promise<LastUpdateMarker | null> {
	try {
		return await api<LastUpdateMarker>('/updates/last');
	} catch (err) {
		if ((err as { status?: number }).status === 404) return null;
		throw err;
	}
}

/**
 * Light healthcheck — used by the update modal to poll for the backend to
 * come back after the container restart. Times out fast so the UI feels
 * responsive.
 */
export async function pingHealth(timeoutMs = 1500): Promise<{ status: string; version: string } | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch('/api/health', { signal: ctrl.signal });
		if (!res.ok) return null;
		const data = (await res.json()) as { status?: string; version?: string };
		if (!data.version) return null;
		return { status: data.status ?? 'unknown', version: data.version };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
