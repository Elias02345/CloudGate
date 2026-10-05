/**
 * Playit account + tunnel routes.
 *
 *   POST   /accounts                 — link a Playit account (label + secret_key)
 *   GET    /accounts                 — list linked accounts for current user
 *   DELETE /accounts/:id             — unlink
 *   GET    /accounts/:id/quota       — fetch live TCP/UDP usage from Playit
 *   POST   /claim                    — start linking via a playit.gg claim link
 *   POST   /claim/:code              — poll a claim; links the account once approved
 */

import { randomBytes } from 'node:crypto';
import { CreatePlayitAccountRequestSchema } from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import {
	createAccount,
	decryptPlayitSecret,
	deleteAccount,
	ensurePlayitTunnelRow,
	getAccountById,
	listAccountsForUser,
	publicPlayitAccount,
} from '../services/playit-account.js';
import { PLAYIT_AGENT_VERSION } from '../services/playit-binary.js';
import { startTunnel } from '../services/tunnel-manager.js';
import {
	PlayitApiError,
	claimExchange,
	claimSetup,
	claimUrl,
	createPlayitClient,
} from '../services/tunnel-providers/playit/client.js';
import { destroyTunnelsForAccount } from '../services/tunnel-teardown.js';

const log = childLogger('routes:playit');
export const playitRouter: RouterType = Router();

/** Give a freshly linked account its tunnel row and bring the agent online. */
async function startAgentFor(accountId: number, label: string): Promise<void> {
	const tunnelId = await ensurePlayitTunnelRow(accountId, label);
	try {
		await startTunnel(tunnelId);
	} catch (err) {
		log.warn({ err: (err as Error).message, accountId }, 'playit agent start failed (account stays linked)');
	}
}

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
			await createPlayitClient(secret_key).runData();
		} catch (err) {
			if (err instanceof PlayitApiError) {
				res.status(err.status === 0 ? 502 : 400).json({ error: err.message, code: err.code });
				return;
			}
			throw err;
		}

		const row = await createAccount({ user_id: req.user.id, label, secret_key });
		await startAgentFor(row.id, row.label);
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
		// Ownership first: the teardown below selects tunnels by account id
		// alone, so it must not run for an account this user does not own.
		if (!(await getAccountById(id, req.user.id))) {
			res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
			return;
		}

		// tunnels.playit_account_id carries no foreign key, so nothing cleaned
		// up after this at all: the agent kept running and the tunnel rows
		// were left pointing at an account that no longer exists, which only
		// shows up later as a decrypt failure nobody can explain.
		await destroyTunnelsForAccount('playit_account_id', id, req.user.id);

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
		// playit reports the account's real port allowance (free or premium).
		const { tcp, udp } = await createPlayitClient(decryptPlayitSecret(row)).listTunnels();
		res.json({
			quota: { tcp_used: tcp.claimed, udp_used: udp.claimed, tcp_limit: tcp.allowed, udp_limit: udp.allowed },
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

// ---------------------------------------------------------------------------
// Claim flow — the same one `playit claim` uses: we make up a code, the user
// approves it at playit.gg/claim/<code> while logged in (a free account is
// enough), and we exchange the approved code for an agent secret. Nobody has
// to copy a secret around.
// ---------------------------------------------------------------------------

const CLAIM_TTL_MS = 15 * 60_000;
/** code → who started it, so only that user can finish (and store) the claim. */
const pendingClaims = new Map<string, { userId: number; expiresAt: number }>();

playitRouter.post('/claim', requireAuth, requirePasswordSet, (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const now = Date.now();
	for (const [code, c] of pendingClaims) if (c.expiresAt < now) pendingClaims.delete(code);
	const code = randomBytes(5).toString('hex');
	pendingClaims.set(code, { userId: req.user.id, expiresAt: now + CLAIM_TTL_MS });
	res.status(201).json({ code, url: claimUrl(code) });
});

playitRouter.post(
	'/claim/:code',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'playit_account.created',
		entityType: 'playit_account',
		meta: (req) => ({ label: req.body?.label, via: 'claim' }),
	}),
	async (req, res) => {
		if (!req.user) {
			res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
			return;
		}
		const code = String(req.params.code ?? '');
		const pending = pendingClaims.get(code);
		if (!pending || pending.userId !== req.user.id || pending.expiresAt < Date.now()) {
			res.status(404).json({ error: 'Claim not found or expired', code: 'NOT_FOUND' });
			return;
		}
		const label =
			typeof req.body?.label === 'string' && req.body.label.trim()
				? req.body.label.trim().slice(0, 80)
				: 'playit.gg';
		try {
			const state = await claimSetup(code, `CloudGate (playit ${PLAYIT_AGENT_VERSION})`);
			if (state === 'UserRejected') {
				pendingClaims.delete(code);
				res.status(400).json({ error: 'The claim was rejected on playit.gg', code: 'PLAYIT_CLAIM_REJECTED' });
				return;
			}
			if (state !== 'UserAccepted') {
				res.json({ status: state === 'WaitingForUser' ? 'waiting_for_approval' : 'waiting_for_visit' });
				return;
			}
			const secret_key = await claimExchange(code);
			pendingClaims.delete(code);
			const row = await createAccount({ user_id: req.user.id, label, secret_key });
			await startAgentFor(row.id, row.label);
			res.status(201).json({ status: 'linked', account: publicPlayitAccount(row) });
		} catch (err) {
			if (err instanceof PlayitApiError) {
				res
					.status(err.status === 0 || err.status === 429 || err.status >= 500 ? 502 : 400)
					.json({ error: err.message, code: err.code });
				return;
			}
			throw err;
		}
	}
);
