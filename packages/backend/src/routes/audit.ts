/**
 * Audit log read API.
 *
 *   GET /api/audit?page=1&per_page=50&action=...&entity_type=...
 */

import { Router, type Router as RouterType } from 'express';
import { PaginationSchema } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';

export const auditRouter: RouterType = Router();

interface AuditRow {
	id: number;
	user_id: number | null;
	action: string;
	entity_type: string | null;
	entity_id: number | null;
	meta: string | null;
	ip: string | null;
	created_at: string;
}

auditRouter.get('/', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const pageParse = PaginationSchema.safeParse(req.query);
	if (!pageParse.success) {
		res.status(400).json({ error: 'Invalid pagination', code: 'BAD_REQUEST' });
		return;
	}
	const { page, per_page } = pageParse.data;

	const action = typeof req.query.action === 'string' ? req.query.action : null;
	const entityType = typeof req.query.entity_type === 'string' ? req.query.entity_type : null;

	const knex = getDb();
	const query = knex<AuditRow>('audit_log').orderBy('id', 'desc');
	if (action) query.where('action', action);
	if (entityType) query.where('entity_type', entityType);

	const totalRow = await query.clone().count<{ c: number }[]>({ c: '*' }).first();
	const total = Number(totalRow?.c ?? 0);

	const rows = await query.limit(per_page).offset((page - 1) * per_page);

	res.json({
		data: rows.map((r) => ({
			id: r.id,
			user_id: r.user_id,
			action: r.action,
			entity_type: r.entity_type,
			entity_id: r.entity_id,
			meta: safeJson(r.meta),
			ip: r.ip,
			created_at: r.created_at,
		})),
		page,
		per_page,
		total,
	});
});

function safeJson(s: string | null): unknown {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}
