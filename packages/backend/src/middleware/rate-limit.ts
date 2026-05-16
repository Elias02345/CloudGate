/**
 * Rate limiters.
 *
 * Two presets:
 *  - authLimiter: aggressive limits for login endpoint (5 attempts / 15 min / IP)
 *  - globalLimiter: gentle ceiling for all API routes (300 req / min / IP)
 */

import type { RequestHandler } from 'express';
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
	message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
});
