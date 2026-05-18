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
