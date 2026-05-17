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
