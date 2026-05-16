/**
 * Audit log writer.
 *
 * Fire-and-forget — failures here never break the actual operation.
 * Reads come from routes/audit.ts.
 */

import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';

const log = childLogger('audit');

export interface AuditEntry {
	user_id?: number | null;
	action: string;
	entity_type?: string | null;
	entity_id?: number | null;
	meta?: Record<string, unknown>;
	ip?: string | null;
}

export function record(entry: AuditEntry): void {
	// Best-effort, async, never throws into caller
	const knex = getDb();
	knex('audit_log')
		.insert({
			user_id: entry.user_id ?? null,
			action: entry.action,
			entity_type: entry.entity_type ?? null,
			entity_id: entry.entity_id ?? null,
			meta: entry.meta ? JSON.stringify(entry.meta) : null,
			ip: entry.ip ?? null,
			created_at: new Date().toISOString(),
		})
		.catch((err) => log.warn({ err: (err as Error).message, action: entry.action }, 'audit write failed'));
}
