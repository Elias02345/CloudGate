/**
 * Auth routes: /api/auth/*
 *
 * - POST /login          — email + password → JWT
 * - POST /logout         — client-side concern; this just acks
 * - GET  /me             — current user info (requires JWT)
 * - POST /password       — change own password (requires JWT)
 *
 * 2FA flow comes in M4. Refresh tokens are skipped in M1 (we'll add
 * httpOnly cookie + refresh in M2 polish).
 */

import { unlink } from 'node:fs/promises';
import { Router, type Router as RouterType } from 'express';
import { authenticator } from 'otplib';
import { ChangePasswordRequestSchema, LoginRequestSchema } from '@cloudgate/shared';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { record } from '../services/audit.js';
import {
	changePassword,
	findUserByEmail,
	issueAccessToken,
	publicUser,
	recordLogin,
	verifyPassword,
} from '../services/auth.js';
import { decryptJson } from '../services/crypto.js';

interface EncryptedTotpSecret {
	type: 'totp';
	secret: string;
}

const log = childLogger('routes:auth');
export const authRouter: RouterType = Router();

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
authRouter.post('/login', authLimiter, async (req, res) => {
	const parsed = LoginRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid login payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const { email, password } = parsed.data;

	const user = await findUserByEmail(email);
	if (!user) {
		// Constant-time-ish behaviour: still hash a fake password to avoid timing leak
		await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$abcdefgh$ijklmnop', password);
		log.info({ email }, 'Login failed: user not found');
		res.status(401).json({ error: 'Invalid email or password', code: 'AUTH_FAILED' });
		return;
	}

	const ok = await verifyPassword(user.password_hash, password);
	if (!ok) {
		log.info({ email }, 'Login failed: password mismatch');
		res.status(401).json({ error: 'Invalid email or password', code: 'AUTH_FAILED' });
		return;
	}

	if (user.totp_enabled) {
		if (!parsed.data.totp_code) {
			res.status(401).json({ error: 'TOTP code required', code: 'TOTP_REQUIRED' });
			return;
		}
		if (!user.totp_secret) {
			log.warn({ user_id: user.id }, 'totp_enabled but no secret stored — refusing login');
			res.status(500).json({ error: 'Account misconfigured', code: 'INTERNAL' });
			return;
		}
		try {
			const decrypted = decryptJson<EncryptedTotpSecret>(user.totp_secret);
			if (!authenticator.verify({ token: parsed.data.totp_code, secret: decrypted.secret })) {
				res.status(401).json({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
				return;
			}
		} catch (err) {
			log.error({ err: (err as Error).message }, 'totp decrypt failed');
			res.status(500).json({ error: 'TOTP verification failed', code: 'INTERNAL' });
			return;
		}
	}

	await recordLogin(user.id);
	record({ user_id: user.id, action: 'auth.login', ip: req.ip ?? null });
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

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------
authRouter.post('/logout', requireAuth, async (_req, res) => {
	// JWTs are stateless; client should drop the token. Once we add refresh
	// tokens in M2, this endpoint will revoke the refresh side.
	res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------
authRouter.get('/me', requireAuth, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing on authenticated request', code: 'INTERNAL' });
		return;
	}
	res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// POST /password — change own password
// ---------------------------------------------------------------------------
authRouter.post('/password', requireAuth, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing on authenticated request', code: 'INTERNAL' });
		return;
	}
	const parsed = ChangePasswordRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res
			.status(400)
			.json({ error: 'Invalid password change payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const { current_password, new_password, email, name } = parsed.data;
	const ok = await verifyPassword(req.user.password_hash, current_password);
	if (!ok) {
		res.status(401).json({ error: 'Current password incorrect', code: 'AUTH_FAILED' });
		return;
	}
	if (current_password === new_password) {
		res.status(400).json({ error: 'New password must differ from current', code: 'BAD_REQUEST' });
		return;
	}

	await changePassword(req.user.id, new_password);

	// First-login flow: also let the user pick their own email + name if
	// they're still on the auto-generated defaults. This is the one-shot
	// "set up your admin account" moment.
	if (req.user.must_change_password && (email || name)) {
		const knex = (await import('../db/db.js')).getDb();
		const updates: Record<string, string> = { updated_at: new Date().toISOString() };
		if (email && email !== req.user.email) {
			// Email-uniqueness check
			const existing = await knex('users').where({ email: email.toLowerCase() }).whereNot({ id: req.user.id }).first();
			if (existing) {
				res.status(409).json({ error: 'Email already in use', code: 'CONFLICT' });
				return;
			}
			updates.email = email.toLowerCase();
		}
		if (name) updates.name = name;
		if (Object.keys(updates).length > 1) {
			await knex('users').where({ id: req.user.id }).update(updates);
			log.info({ user_id: req.user.id, updates }, 'First-login profile updated');
		}
	}

	// On first password change after bootstrap-seeded admin, drop the plaintext file.
	if (req.user.must_change_password) {
		try {
			await unlink(dataPath('secrets', 'initial-admin.txt'));
			log.info('Removed /data/secrets/initial-admin.txt after first password change');
		} catch {
			/* file may not exist — fine */
		}
	}

	log.info({ user_id: req.user.id }, 'Password changed');
	res.json({ ok: true });
});
