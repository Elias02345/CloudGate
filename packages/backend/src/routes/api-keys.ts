/**
 * /api/api-keys — manage long-lived shell-API tokens.
 *
 * Browser SPA uses these via the new ApiKeysPage to issue tokens for `curl`,
 * AI agents, scripts. Keys themselves authenticate via Bearer (see
 * middleware/api-key.ts). All routes here require JWT — you can't manage
 * keys with another key, by design.
 *
 *   GET    /api/api-keys          — list current user's keys
 *   POST   /api/api-keys          — create new key (returns plaintext once)
 *   DELETE /api/api-keys/:id      — revoke
 *   POST   /api/api-keys/:id/rotate  — rotate (new plaintext, old invalidated)
 */

import { CreateApiKeyRequestSchema } from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from '../services/api-keys.js';
import { record } from '../services/audit.js';

const log = childLogger('routes:api-keys');
export const apiKeysRouter: RouterType = Router();

const MAX_KEYS_PER_USER = 20;

// Block API-key callers from managing other keys — only browser sessions
// (JWT) can mint or revoke. Catches the case where a holder of a leaked key
// tries to enumerate / rotate.
function blockApiKeyCaller(): import('express').RequestHandler {
	return (req, res, next) => {
		if (req.apiKey) {
			res.status(403).json({
				error: 'Key management requires a browser session, not an API key',
				code: 'BROWSER_ONLY',
			});
			return;
		}
		next();
	};
}

apiKeysRouter.use(requireAuth, requirePasswordSet, blockApiKeyCaller());

// ---------------------------------------------------------------------------
// GET /api/api-keys
// ---------------------------------------------------------------------------
apiKeysRouter.get('/', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const keys = await listApiKeys(req.user.id);
	res.json({ keys });
});

// ---------------------------------------------------------------------------
// POST /api/api-keys — issue a new key
// ---------------------------------------------------------------------------
apiKeysRouter.post('/', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = CreateApiKeyRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}

	const existing = await listApiKeys(req.user.id);
	if (existing.length >= MAX_KEYS_PER_USER) {
		res.status(409).json({
			error: `Limit of ${MAX_KEYS_PER_USER} keys per user reached — revoke an old one first`,
			code: 'LIMIT_REACHED',
		});
		return;
	}

	const result = await createApiKey({
		user_id: req.user.id,
		name: parsed.data.name,
		scope: parsed.data.scope,
		expires_at: parsed.data.expires_at ?? null,
	});

	record({
		user_id: req.user.id,
		action: 'api_key.created',
		entity_type: 'api_key',
		entity_id: result.row.id,
		meta: { name: result.row.name, scope: result.row.scope, prefix: result.row.prefix },
		ip: req.ip ?? null,
	});
	log.info(
		{ user_id: req.user.id, key_id: result.row.id, prefix: result.row.prefix, scope: result.row.scope },
		'API key created'
	);

	res.status(201).json({ key: result.row, plaintext: result.plaintext });
});

// ---------------------------------------------------------------------------
// DELETE /api/api-keys/:id
// ---------------------------------------------------------------------------
apiKeysRouter.delete('/:id', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) {
		res.status(400).json({ error: 'Invalid id', code: 'BAD_REQUEST' });
		return;
	}
	const ok = await revokeApiKey(req.user.id, id);
	if (!ok) {
		res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
		return;
	}
	record({
		user_id: req.user.id,
		action: 'api_key.revoked',
		entity_type: 'api_key',
		entity_id: id,
		ip: req.ip ?? null,
	});
	res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/api-keys/:id/rotate
// ---------------------------------------------------------------------------
apiKeysRouter.post('/:id/rotate', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) {
		res.status(400).json({ error: 'Invalid id', code: 'BAD_REQUEST' });
		return;
	}
	const result = await rotateApiKey(req.user.id, id);
	if (!result) {
		res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
		return;
	}
	record({
		user_id: req.user.id,
		action: 'api_key.rotated',
		entity_type: 'api_key',
		entity_id: id,
		meta: { new_prefix: result.row.prefix },
		ip: req.ip ?? null,
	});
	res.json({ key: result.row, plaintext: result.plaintext });
});
