/**
 * Audit middleware.
 *
 * Wraps a route to automatically record writing operations (POST/PUT/DELETE)
 * to the audit_log table. The handler keeps full control — middleware only
 * observes (success/failure are logged based on the response status code).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { record } from '../services/audit.js';

interface AuditOptions {
	action: string;
	entityType?: string;
	/** Extract the entity id from the request (params or body). Optional. */
	entityId?: (req: Request, res: Response) => number | null;
	/** Extract additional metadata. Optional. */
	meta?: (req: Request, res: Response) => Record<string, unknown> | undefined;
}

export function audit(opts: AuditOptions): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		const finish = () => {
			// Only record on success-ish responses + writing methods
			if (req.method === 'GET') return;
			if (res.statusCode >= 400) return;
			const m = opts.meta ? opts.meta(req, res) : undefined;
			const entityId = opts.entityId ? opts.entityId(req, res) : null;
			record({
				user_id: req.user?.id ?? null,
				action: opts.action,
				entity_type: opts.entityType ?? null,
				entity_id: entityId,
				...(m ? { meta: m } : {}),
				ip: req.ip ?? null,
			});
		};
		res.on('finish', finish);
		next();
	};
}
