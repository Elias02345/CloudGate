/**
 * 2FA / TOTP routes.
 *
 *   POST /totp/setup       — generates secret + returns provisioning URI/QR
 *   POST /totp/enable      — verifies a code + stores the secret + flips totp_enabled
 *   POST /totp/disable     — verifies password + clears secret + flips off
 *
 * Storage: totp_secret is stored encrypted-at-rest using the same encryption
 * key as Cloudflare tokens (services/crypto).
 */

import { Router, type Router as RouterType } from 'express';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import { verifyPassword } from '../services/auth.js';
import { decryptJson, encryptJson } from '../services/crypto.js';

export const totpRouter: RouterType = Router();

const ISSUER = 'CloudGate';

interface EncryptedSecret {
	type: 'totp';
	secret: string;
}

function getStoredSecret(encrypted: Buffer | string | null): string | null {
	if (!encrypted) return null;
	const raw = typeof encrypted === 'string' ? encrypted : encrypted.toString('utf8');
	try {
		const parsed = decryptJson<EncryptedSecret>(raw);
		return parsed.type === 'totp' ? parsed.secret : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// POST /totp/setup
// ---------------------------------------------------------------------------
totpRouter.post('/setup', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	if (req.user.totp_enabled) {
		res.status(400).json({ error: 'TOTP already enabled. Disable first to re-setup.', code: 'TOTP_ALREADY_ENABLED' });
		return;
	}
	const secret = authenticator.generateSecret();
	const otpAuthUrl = authenticator.keyuri(req.user.email, ISSUER, secret);
	const qrDataUrl = await qrcode.toDataURL(otpAuthUrl);

	// Stash the pending secret in a short-lived pending_totp_secret column?
	// Simpler: send it back to the client unencrypted ONCE — client passes it
	// back in /enable. This avoids needing a new DB column for pending state.
	res.json({
		secret, // base32 — user can paste manually if QR doesn't work
		otpauth_url: otpAuthUrl,
		qr_code_data_url: qrDataUrl,
	});
});

// ---------------------------------------------------------------------------
// POST /totp/enable
// ---------------------------------------------------------------------------
const EnableSchema = z.object({
	secret: z.string().min(16),
	code: z.string().regex(/^\d{6}$/),
});

totpRouter.post('/enable', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = EnableSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const { secret, code } = parsed.data;

	if (!authenticator.verify({ token: code, secret })) {
		res.status(401).json({ error: 'Invalid TOTP code', code: 'TOTP_INVALID' });
		return;
	}

	const encrypted = encryptJson<EncryptedSecret>({ type: 'totp', secret });
	const knex = getDb();
	await knex('users')
		.where({ id: req.user.id })
		.update({
			totp_secret: encrypted,
			totp_enabled: 1,
			updated_at: new Date().toISOString(),
		});
	record({ user_id: req.user.id, action: 'totp.enabled', ip: req.ip ?? null });
	res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /totp/disable
// ---------------------------------------------------------------------------
const DisableSchema = z.object({
	password: z.string().min(1),
});

totpRouter.post('/disable', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = DisableSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST' });
		return;
	}
	const ok = await verifyPassword(req.user.password_hash, parsed.data.password);
	if (!ok) {
		res.status(401).json({ error: 'Wrong password', code: 'AUTH_FAILED' });
		return;
	}
	const knex = getDb();
	await knex('users')
		.where({ id: req.user.id })
		.update({
			totp_secret: null,
			totp_enabled: 0,
			updated_at: new Date().toISOString(),
		});
	record({ user_id: req.user.id, action: 'totp.disabled', ip: req.ip ?? null });
	res.json({ ok: true });
});

// Touch the helper so tree-shake doesn't complain when nothing else imports it.
void getStoredSecret;
