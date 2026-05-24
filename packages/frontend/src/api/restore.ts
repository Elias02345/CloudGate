import { useQuery } from '@tanstack/react-query';
import { api } from './client.js';

interface Eligibility {
	fresh: boolean;
	has_install: boolean;
	bootstrap_complete: boolean;
}

export function useRestoreEligibility() {
	return useQuery<Eligibility>({
		queryKey: ['restore', 'eligibility'],
		queryFn: () => api('/restore/eligibility'),
		retry: 0,
		// This is checked on the login page (pre-auth) — avoid refetching
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export interface RestoreResult {
	ok: true;
	files: number;
	bytes: number;
	message: string;
}

/**
 * Direct fetch wrapper — TanStack mutate is overkill for one-shot.
 */
export async function runFirstRunRestore(file: File, passphrase: string): Promise<RestoreResult> {
	const buf = await file.arrayBuffer();
	const res = await fetch('/api/restore/first-run', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/octet-stream',
			'X-Cloudgate-Passphrase': passphrase,
		},
		body: buf,
	});
	const data = await res.json();
	if (!res.ok) {
		throw new Error(`${data.error ?? 'restore failed'} (${data.code ?? 'unknown'})`);
	}
	return data as RestoreResult;
}

/**
 * Admin restore — same shape as first-run but the route is auth-gated and
 * accepts ?force=true to overwrite an existing install.
 */
export async function runAdminRestore(
	file: File,
	passphrase: string,
	opts: { force?: boolean } = {}
): Promise<RestoreResult> {
	const buf = await file.arrayBuffer();
	const url = `/api/restore${opts.force ? '?force=true' : ''}`;
	const res = await fetch(url, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/octet-stream',
			'X-Cloudgate-Passphrase': passphrase,
		},
		body: buf,
	});
	const data = await res.json();
	if (!res.ok) {
		throw new Error(`${data.error ?? 'restore failed'} (${data.code ?? 'unknown'})`);
	}
	return data as RestoreResult;
}

/**
 * Backup export — POSTs the passphrase so it doesn't land in proxy access
 * logs. Returns a Blob the caller can save with a generated filename.
 */
export async function runBackupExport(passphrase: string): Promise<{ blob: Blob; filename: string }> {
	const res = await fetch('/api/backup', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ passphrase }),
	});
	if (!res.ok) {
		let msg: string;
		try {
			const data = await res.json();
			msg = `${data.error ?? 'backup failed'} (${data.code ?? 'unknown'})`;
		} catch {
			msg = `backup failed: HTTP ${res.status}`;
		}
		throw new Error(msg);
	}
	const blob = await res.blob();
	// Honour the server-supplied filename if present.
	const cd = res.headers.get('content-disposition') ?? '';
	const match = /filename="([^"]+)"/.exec(cd);
	const filename = match?.[1] ?? `cloudgate-backup-${Date.now()}.cgbk`;
	return { blob, filename };
}
