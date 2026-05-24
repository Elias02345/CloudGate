/**
 * Playit account + tunnel routes.
 *
 *   POST   /accounts                 — link a Playit account (label + secret_key)
 *   GET    /accounts                 — list linked accounts for current user
 *   DELETE /accounts/:id             — unlink
 *   GET    /accounts/:id/quota       — fetch live TCP/UDP usage from Playit
 */

import { CreatePlayitAccountRequestSchema } from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import {
	createAccount,
	decryptPlayitSecret,
	deleteAccount,
	getAccountById,
	listAccountsForUser,
	publicPlayitAccount,
} from '../services/playit-account.js';
import {
	PLAYIT_FREE_TIER,
	PlayitApiError,
	createPlayitClient,
} from '../services/tunnel-providers/playit/client.js';

const log = childLogger('routes:playit');
export const playitRouter: RouterType = Router();

// ---------------------------------------------------------------------------
// POST /accounts
// ---------------------------------------------------------------------------
playitRouter.post(
	'/accounts',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'playit_account.created',
		entityType: 'playit_account',
		meta: (req) => ({ label: req.body?.label }),
	}),
	async (req, res) => {
		if (!req.user) {
			res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
			return;
		}
		const parsed = CreatePlayitAccountRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
			return;
		}
		const { label, secret_key } = parsed.data;

		// Validate the key by attempting a status call. Reject early on bad keys.
		try {
			const client = createPlayitClient(secret_key);
			await client.verify();
		} catch (err) {
			if (err instanceof PlayitApiError) {
				res.status(err.status === 0 ? 502 : 400).json({ error: err.message, code: err.code });
				return;
			}
			throw err;
		}

		const row = await createAccount({ user_id: req.user.id, label, secret_key });
		res.status(201).json({ account: publicPlayitAccount(row) });
	}
);

// ---------------------------------------------------------------------------
// GET /accounts
// ---------------------------------------------------------------------------
playitRouter.get('/accounts', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const rows = await listAccountsForUser(req.user.id);
	res.json({ accounts: rows.map(publicPlayitAccount) });
});

// ---------------------------------------------------------------------------
// DELETE /accounts/:id
// ---------------------------------------------------------------------------
playitRouter.delete(
	'/accounts/:id',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'playit_account.deleted',
		entityType: 'playit_account',
		entityId: (req) => Number.parseInt(String(req.params.id ?? ''), 10) || null,
	}),
	async (req, res) => {
		if (!req.user) {
			res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
			return;
		}
		const id = Number.parseInt(String(req.params.id ?? ''), 10);
		if (!Number.isFinite(id)) {
			res.status(400).json({ error: 'Invalid id', code: 'BAD_REQUEST' });
			return;
		}
		const ok = await deleteAccount(id, req.user.id);
		if (!ok) {
			res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
			return;
		}
		res.status(204).end();
	}
);

// ---------------------------------------------------------------------------
// GET /accounts/:id/quota
// ---------------------------------------------------------------------------
playitRouter.get('/accounts/:id/quota', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await getAccountById(id, req.user.id);
	if (!row) {
		res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
		return;
	}
	try {
		const client = createPlayitClient(decryptPlayitSecret(row));
		const tunnels = await client.listTunnels();
		const tcp_used = tunnels.filter((t) => t.protocol === 'tcp').length;
		const udp_used = tunnels.filter((t) => t.protocol === 'udp').length;
		res.json({
			quota: {
				tcp_used,
				udp_used,
				tcp_limit: PLAYIT_FREE_TIER.TCP,
				udp_limit: PLAYIT_FREE_TIER.UDP,
			},
		});
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'Playit quota fetch failed');
		if (err instanceof PlayitApiError) {
			res.status(502).json({ error: err.message, code: err.code });
			return;
		}
		throw err;
	}
});
