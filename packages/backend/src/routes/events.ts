/**
 * SSE event stream endpoint.
 *
 *   GET /api/events            — subscribe to all topics
 *   GET /api/events?topic=...  — comma-separated filter
 *
 * Auth via token in `?access_token=...` query param because EventSource
 * cannot set custom headers. The query param is then validated like a Bearer.
 */

import { Router, type Router as RouterType } from 'express';
import { childLogger } from '../logger.js';
import { findUserById, verifyAccessToken } from '../services/auth.js';
import { subscribe, type EventTopic } from '../services/events.js';

const log = childLogger('routes:events');
export const eventsRouter: RouterType = Router();

eventsRouter.get('/', async (req, res) => {
	// Token from header (preferred) or query (for EventSource)
	const auth = req.header('authorization');
	const headerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
	const queryToken = typeof req.query.access_token === 'string' ? req.query.access_token : null;
	const token = headerToken ?? queryToken;
	if (!token) {
		res.status(401).json({ error: 'Missing token', code: 'UNAUTHENTICATED' });
		return;
	}
	try {
		const claims = await verifyAccessToken(token);
		const userId = Number.parseInt(claims.sub, 10);
		const user = await findUserById(userId);
		if (!user) {
			res.status(401).json({ error: 'User not found', code: 'UNAUTHENTICATED' });
			return;
		}
	} catch (err) {
		log.debug({ err: (err as Error).message }, 'SSE auth failed');
		res.status(401).json({ error: 'Invalid token', code: 'UNAUTHENTICATED' });
		return;
	}

	const topicsParam = typeof req.query.topics === 'string' ? req.query.topics : null;
	const topics = topicsParam
		? (topicsParam.split(',').filter(Boolean) as EventTopic[])
		: undefined;

	subscribe(res, { ...(topics ? { topics } : {}) });
});
