/**
 * Auth middleware — extracts Bearer token, verifies JWT, attaches user to req.
 *
 * Usage:
 *   router.get('/me', requireAuth, async (req, res) => {
 *     res.json({ user: req.user });
 *   });
 *
 *   router.delete('/users/:id', requireAuth, requireAdmin, async ...);
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { findUserById, publicUser, verifyAccessToken, type DbUser } from '../services/auth.js';
import { childLogger } from '../logger.js';

const log = childLogger('middleware:auth');

declare global {
	// biome-ignore lint/style/noNamespace: needed to augment Express
	namespace Express {
		interface Request {
			user?: DbUser;
		}
	}
}

function extractToken(req: Request): string | null {
	const header = req.header('authorization');
	if (!header) return null;
	const [scheme, token] = header.split(' ', 2);
	if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
	return token;
}

export const requireAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
	const token = extractToken(req);
	if (!token) {
		res.status(401).json({ error: 'Missing or malformed Authorization header', code: 'UNAUTHENTICATED' });
		return;
	}
	try {
		const claims = await verifyAccessToken(token);
		const userId = Number.parseInt(claims.sub, 10);
		if (!Number.isFinite(userId)) {
			res.status(401).json({ error: 'Invalid token subject', code: 'UNAUTHENTICATED' });
			return;
		}
		const user = await findUserById(userId);
		if (!user) {
			res.status(401).json({ error: 'User no longer exists', code: 'UNAUTHENTICATED' });
			return;
		}
		req.user = user;
		next();
	} catch (err) {
		log.debug({ err: (err as Error).message }, 'Token verification failed');
		res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHENTICATED' });
	}
};

export const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
	if (!req.user) {
		res.status(401).json({ error: 'Not authenticated', code: 'UNAUTHENTICATED' });
		return;
	}
	if (!req.user.is_admin) {
		res.status(403).json({ error: 'Admin privileges required', code: 'FORBIDDEN' });
		return;
	}
	next();
};

/**
 * Same as requireAuth but BLOCKS if the user must change their password.
 * Use this for routes that should only be reachable after password setup is done.
 */
export const requirePasswordSet: RequestHandler = async (req, res, next) => {
	const inner = requireAuth as RequestHandler;
	inner(req, res, (err) => {
		if (err) {
			next(err);
			return;
		}
		if (req.user?.must_change_password) {
			res.status(403).json({
				error: 'Password change required before accessing this resource',
				code: 'PASSWORD_CHANGE_REQUIRED',
			});
			return;
		}
		next();
	});
};

/** Re-export the public-user shape helper for routes that want to send it. */
export { publicUser };
