/**
 * Rate limiters.
 *
 * Three presets:
 *  - authLimiter:    5 attempts / 15 min / IP on login
 *  - globalLimiter:  300 req / min / IP (browser + unauthenticated)
 *  - apiKeyLimiter:  per-key tier for cgk_* Bearer callers (admin 60/min,
 *                     read 120/min), keyed on the API key id so multiple
 *                     keys / shared IPs don't trip each other
 */

import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

export const authLimiter: RequestHandler = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 5,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMITED' },
});

/**
 * Per-account cap on top of the per-IP one. req.ip can be forged when the
 * request reaches us through a loopback hop (tunnel → nginx → us), which
 * would give an attacker a fresh authLimiter bucket per request. Successful
 * logins are not counted, so a legitimate user is never locked out by their
 * own history. Trade-off, deliberately accepted: because the key is the
 * account alone (an IP-based key is exactly what can be forged), someone can
 * lock the account out of the login form by sending this many bad attempts.
 * 30 / 15 min still caps online guessing at ~2 guesses per minute, and the
 * lock lapses by itself.
 */
export const accountLoginLimiter: RequestHandler = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 30,
	standardHeaders: false,
	legacyHeaders: false,
	skipSuccessfulRequests: true,
	keyGenerator: (req: Request) => {
		const email = (req.body as { email?: unknown } | undefined)?.email;
		return `acct:${typeof email === 'string' ? email.toLowerCase().slice(0, 254) : 'none'}`;
	},
	message: { error: 'Too many login attempts, please try again later.', code: 'RATE_LIMITED' },
});

export const globalLimiter: RequestHandler = rateLimit({
	windowMs: 60 * 1000, // 1 minute
	limit: 300,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	// Skip API-key callers — they have their own tier below.
	skip: (req: Request) => !!req.apiKey,
	message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
});

export const apiKeyLimiter: RequestHandler = rateLimit({
	windowMs: 60 * 1000,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	// Only apply to API-key bearers — skip everything else.
	skip: (req: Request) => !req.apiKey,
	limit: (req: Request) => (req.apiKey?.scope === 'read' ? 120 : 60),
	keyGenerator: (req: Request) => (req.apiKey ? `key:${req.apiKey.id}` : (req.ip ?? 'anon')),
	message: { error: 'API key rate limit exceeded', code: 'RATE_LIMITED' },
});
