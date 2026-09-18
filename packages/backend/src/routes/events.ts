/**
 * SSE event stream endpoint.
 *
 *   GET /api/events            — subscribe to all topics
 *   GET /api/events?topic=...  — comma-separated filter
 *
 *   POST /api/events/ticket    — mint a short-lived ticket for EventSource
 *
 * Auth: an `Authorization: Bearer` header when the caller can set one, or a
 * `?ticket=...` minted by POST /ticket for EventSource, which cannot. The
 * session token is deliberately NOT accepted from the query string: nginx logs
 * the full request line, so a credential in a URL ends up on disk on every
 * page load. The ticket exists to be the thing that leaks instead — a minute
 * long, and useless anywhere but this stream.
 */

import { Router, type Router as RouterType } from 'express';
import { childLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { findUserById, issueSseTicket, verifyAccessToken, verifySseTicket } from '../services/auth.js';
import { type EventTopic, subscribe } from '../services/events.js';

const log = childLogger('routes:events');
export const eventsRouter: RouterType = Router();

eventsRouter.post('/ticket', requireAuth, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing on authenticated request', code: 'INTERNAL' });
		return;
	}
	res.json({ ticket: await issueSseTicket(req.user.id) });
});

eventsRouter.get('/', async (req, res) => {
	const auth = req.header('authorization');
	const headerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
	const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
	if (!headerToken && !ticket) {
		res.status(401).json({ error: 'Missing token', code: 'UNAUTHENTICATED' });
		return;
	}
	try {
		const sub = headerToken
			? (await verifyAccessToken(headerToken)).sub
			: (await verifySseTicket(ticket as string)).sub;
		const user = await findUserById(Number.parseInt(sub, 10));
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
	const topics = topicsParam ? (topicsParam.split(',').filter(Boolean) as EventTopic[]) : undefined;

	subscribe(res, { ...(topics ? { topics } : {}) });
});
