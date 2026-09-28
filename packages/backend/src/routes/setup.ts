/**
 * First-run admin setup: /api/setup/*
 *
 * - GET  /status — public: whether setup is needed and still open.
 * - POST /       — public: create the one-and-only admin account, allowed
 *                  only while zero users exist, the setup window is open,
 *                  and the caller looks like it's on the local network.
 *
 * Fresh installs no longer get a random admin password buried in a log line
 * or /data/secrets/initial-admin.txt (see bootstrap.ts `seedAdminIfMissing`)
 * — the web UI's Setup page creates the account here instead, then logs the
 * caller in exactly like POST /api/auth/login.
 */

import { SetupRequestSchema } from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { getConfig } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { record } from '../services/audit.js';
import { issueAccessToken, publicUser } from '../services/auth.js';
import { isPrivateNetworkRequest } from '../services/network-origin.js';
import { PROCESS_STARTED_AT, computeSetupWindow } from '../services/setup-window.js';
import { SetupError, createInitialAdmin } from '../services/setup.js';

const log = childLogger('routes:setup');
export const setupRouter: RouterType = Router();

async function needsSetup(): Promise<boolean> {
	const knex = getDb();
	const row = await knex('users').count<{ c: number }[]>({ c: '*' }).first();
	return !row || Number(row.c) === 0;
}

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------
setupRouter.get('/status', async (_req, res) => {
	const cfg = getConfig();
	const window = computeSetupWindow(PROCESS_STARTED_AT, cfg.CLOUDGATE_SETUP_WINDOW_MINUTES, Date.now());
	res.json({
		needs_setup: await needsSetup(),
		window_open: window.open,
		window_closes_at: window.closesAt,
	});
});

// ---------------------------------------------------------------------------
// POST / — create the initial admin
// ---------------------------------------------------------------------------
setupRouter.post('/', authLimiter, async (req, res) => {
	if (!(await needsSetup())) {
		res.status(409).json({ error: 'An admin account already exists.', code: 'SETUP_DONE' });
		return;
	}

	const cfg = getConfig();
	const window = computeSetupWindow(PROCESS_STARTED_AT, cfg.CLOUDGATE_SETUP_WINDOW_MINUTES, Date.now());
	if (!window.open) {
		res.status(403).json({
			error: `Setup closed ${cfg.CLOUDGATE_SETUP_WINDOW_MINUTES} minutes after start. Restart the CloudGate container/app to reopen it.`,
			code: 'SETUP_WINDOW_CLOSED',
		});
		return;
	}

	const local = isPrivateNetworkRequest({
		ip: req.ip,
		xForwardedFor: req.headers['x-forwarded-for'],
		cfConnectingIp: req.headers['cf-connecting-ip'],
	});
	if (!local) {
		res.status(403).json({
			error: 'Setup is only allowed from the local network.',
			code: 'SETUP_NOT_LOCAL',
		});
		return;
	}

	const parsed = SetupRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res
			.status(400)
			.json({ error: 'Invalid setup payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}

	let user: Awaited<ReturnType<typeof createInitialAdmin>>;
	try {
		user = await createInitialAdmin(parsed.data);
	} catch (err) {
		if (err instanceof SetupError) {
			res.status(409).json({ error: err.message, code: err.code });
			return;
		}
		log.error({ err: (err as Error).message }, 'Initial admin creation failed');
		res.status(500).json({ error: 'Could not create admin account', code: 'INTERNAL' });
		return;
	}

	record({ user_id: user.id, action: 'auth.setup', ip: req.ip ?? null });
	log.info({ user_id: user.id, email: user.email }, 'Initial admin created via setup page');

	const token = await issueAccessToken({
		sub: String(user.id),
		email: user.email,
		is_admin: Boolean(user.is_admin),
	});

	res.json({
		access_token: token,
		user: publicUser(user),
		must_change_password: Boolean(user.must_change_password),
	});
});
