/**
 * Cloudflare account & zone routes.
 *
 *   POST   /accounts             — add a new CF account (validates token)
 *   GET    /accounts             — list user's accounts
 *   DELETE /accounts/:id         — remove an account (cascades zones via FK)
 *   POST   /accounts/:id/sync    — refresh zone list from CF
 *   GET    /accounts/:id/zones   — list cached zones
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import {
	type DbCfAccount,
	createAccount,
	decryptCredentials,
	deleteAccount,
	getAccountById,
	listAccountsForUser,
	publicAccount,
	touchValidated,
} from '../services/cf-account.js';
import {
	CloudflareApiError,
	listAccounts as cfListAccounts,
	listZones as cfListZones,
	verifyToken,
} from '../services/cloudflare-client.js';
import { getDb } from '../db/db.js';

const log = childLogger('routes:cloudflare');
export const cloudflareRouter: RouterType = Router();

const CreateAccountSchema = z.object({
	label: z.string().min(1).max(100),
	api_token: z.string().min(20),
});

// ---------------------------------------------------------------------------
// POST /accounts
// ---------------------------------------------------------------------------
cloudflareRouter.post('/accounts', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = CreateAccountSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const { label, api_token } = parsed.data;

	try {
		const tokenInfo = await verifyToken(api_token);
		if (tokenInfo.status !== 'active') {
			res.status(400).json({
				error: `Token is not active (status: ${tokenInfo.status})`,
				code: 'CF_TOKEN_INACTIVE',
			});
			return;
		}
		const accounts = await cfListAccounts(api_token);
		if (accounts.length === 0) {
			res.status(400).json({
				error: 'Token has no account access. Re-create with Account.Tunnels:Edit scope.',
				code: 'CF_NO_ACCOUNTS',
			});
			return;
		}
		// For M1 we take the first account. Multi-account support comes in vNext.
		const first = accounts[0]!;
		const row = await createAccount({
			user_id: req.user.id,
			label,
			auth_type: 'api_token',
			credentials: { type: 'api_token', token: api_token },
			account_tag: first.id,
			email: null,
		});
		// Async zone sync — doesn't block the response
		void doZoneSync(row).catch((err) =>
			log.warn({ err: (err as Error).message, account_id: row.id }, 'Initial zone sync failed')
		);
		res.status(201).json({ account: publicAccount(row) });
	} catch (err) {
		if (err instanceof CloudflareApiError) {
			res.status(err.status === 401 || err.status === 403 ? 400 : 502).json({
				error: err.message,
				code: err.code,
			});
			return;
		}
		throw err;
	}
});

// ---------------------------------------------------------------------------
// GET /accounts
// ---------------------------------------------------------------------------
cloudflareRouter.get('/accounts', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const rows = await listAccountsForUser(req.user.id);
	res.json({ accounts: rows.map(publicAccount) });
});

// ---------------------------------------------------------------------------
// DELETE /accounts/:id
// ---------------------------------------------------------------------------
cloudflareRouter.delete('/accounts/:id', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(req.params.id ?? '', 10);
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
});

// ---------------------------------------------------------------------------
// POST /accounts/:id/sync — refresh zones from CF
// ---------------------------------------------------------------------------
cloudflareRouter.post('/accounts/:id/sync', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(req.params.id ?? '', 10);
	const account = await getAccountById(id, req.user.id);
	if (!account) {
		res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
		return;
	}
	try {
		const synced = await doZoneSync(account);
		res.json({ count: synced });
	} catch (err) {
		if (err instanceof CloudflareApiError) {
			res.status(err.status === 401 ? 400 : 502).json({ error: err.message, code: err.code });
			return;
		}
		throw err;
	}
});

// ---------------------------------------------------------------------------
// GET /accounts/:id/zones — list cached zones
// ---------------------------------------------------------------------------
cloudflareRouter.get('/accounts/:id/zones', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(req.params.id ?? '', 10);
	const account = await getAccountById(id, req.user.id);
	if (!account) {
		res.status(404).json({ error: 'Account not found', code: 'NOT_FOUND' });
		return;
	}
	const knex = getDb();
	const zones = await knex('cf_zones')
		.where({ cloudflare_account_id: account.id })
		.orderBy('name')
		.select('id', 'zone_id', 'name', 'status', 'last_synced_at');
	res.json({ zones });
});

// ---------------------------------------------------------------------------
// Internal: zone sync helper
// ---------------------------------------------------------------------------
async function doZoneSync(account: DbCfAccount): Promise<number> {
	const creds = decryptCredentials(account);
	if (creds.type !== 'api_token') {
		throw new CloudflareApiError(400, 'CF_UNSUPPORTED_AUTH', 'OAuth zone sync not supported in M1');
	}
	const zones = await cfListZones(creds.token);
	const knex = getDb();
	const now = new Date().toISOString();
	await knex.transaction(async (trx) => {
		await trx('cf_zones').where({ cloudflare_account_id: account.id }).delete();
		if (zones.length > 0) {
			await trx('cf_zones').insert(
				zones.map((z) => ({
					cloudflare_account_id: account.id,
					zone_id: z.id,
					name: z.name,
					status: z.status,
					last_synced_at: now,
				}))
			);
		}
	});
	await touchValidated(account.id);
	log.info({ account_id: account.id, count: zones.length }, 'Synced zones');
	return zones.length;
}
