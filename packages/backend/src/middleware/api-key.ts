/**
 * Shell-API authentication via long-lived API keys.
 *
 * Looks for `Authorization: Bearer cgk_<prefix>_<secret>` and, if present,
 * verifies via api-keys service. Sets req.user and req.apiKey on success.
 * Used by the unified requireAuth middleware which tries API-key first,
 * then falls back to JWT (so cookies / Bearer JWT still work for the SPA).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type ApiKeyScope, verifyApiKey } from '../services/api-keys.js';
import { findUserById } from '../services/auth.js';

declare global {
	// biome-ignore lint/style/noNamespace: needed to augment Express
	namespace Express {
		interface Request {
			apiKey?: {
				id: number;
				scope: ApiKeyScope;
			};
		}
	}
}

const KEY_PREFIX = 'cgk_';

function extractBearer(req: Request): string | null {
	const header = req.header('authorization');
	if (!header) return null;
	const [scheme, token] = header.split(' ', 2);
	if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
	return token;
}

/**
 * Returns true if the incoming Authorization is shaped like an API key.
 * Used by the unified auth middleware to decide which path to try.
 */
export function looksLikeApiKey(req: Request): boolean {
	const t = extractBearer(req);
	return !!t && t.startsWith(KEY_PREFIX);
}

/**
 * Tries to authenticate via API key. Returns true on success (and sets
 * req.user + req.apiKey), false on failure (caller may fall through to JWT).
 */
export async function tryApiKey(req: Request): Promise<boolean> {
	const token = extractBearer(req);
	if (!token || !token.startsWith(KEY_PREFIX)) return false;
	const row = await verifyApiKey(token, req.ip ?? null);
	if (!row) return false;
	const user = await findUserById(row.user_id);
	if (!user) return false;
	req.user = user;
	req.apiKey = { id: row.id, scope: row.scope };
	return true;
}

/**
 * Blocks the request if the caller used a read-only API key for a write
 * operation. JWT-authenticated requests are not affected.
 */
export const requireWriteScope: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
	if (req.apiKey && req.apiKey.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
		res.status(403).json({
			error: 'API key has read-only scope; cannot perform write operations',
			code: 'INSUFFICIENT_SCOPE',
		});
		return;
	}
	next();
};
