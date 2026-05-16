import { useQuery } from '@tanstack/react-query';
import { api } from './client.js';

export interface AuditEntry {
	id: number;
	user_id: number | null;
	action: string;
	entity_type: string | null;
	entity_id: number | null;
	meta: unknown;
	ip: string | null;
	created_at: string;
}

export function useAuditLog(filter: { page?: number; action?: string; entity_type?: string } = {}) {
	const params = new URLSearchParams();
	params.set('page', String(filter.page ?? 1));
	params.set('per_page', '50');
	if (filter.action) params.set('action', filter.action);
	if (filter.entity_type) params.set('entity_type', filter.entity_type);

	return useQuery<{ data: AuditEntry[]; page: number; per_page: number; total: number }>({
		queryKey: ['audit', filter],
		queryFn: () => api(`/audit?${params.toString()}`),
	});
}
