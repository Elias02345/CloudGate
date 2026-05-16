/**
 * Self-update routes.
 *
 *   GET  /                — current updater status
 *   POST /check           — force an immediate check
 *   POST /install         — trigger install of the latest known version
 *   POST /settings        — change channel + mode
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { getStatus, triggerCheck, triggerInstall, updateChannel } from '../services/updater.js';

export const updatesRouter: RouterType = Router();

updatesRouter.get('/', requireAuth, requirePasswordSet, async (_req, res) => {
	res.json(getStatus());
});

updatesRouter.post('/check', requireAuth, requirePasswordSet, async (_req, res) => {
	await triggerCheck();
	res.json(getStatus());
});

const InstallSchema = z.object({
	version: z.string().min(1),
});

updatesRouter.post('/install', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	const parsed = InstallSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Missing version', code: 'BAD_REQUEST' });
		return;
	}
	try {
		await triggerInstall(parsed.data.version);
		res.json({ ok: true, message: 'Install dispatched — container will restart shortly' });
	} catch (err) {
		res.status(500).json({ error: (err as Error).message, code: 'UPDATE_FAILED' });
	}
});

const SettingsSchema = z.object({
	channel: z.enum(['stable', 'prerelease', 'nightly', 'disabled']),
	mode: z.enum(['auto', 'notify', 'scheduled']),
});

updatesRouter.post('/settings', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	const parsed = SettingsSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid settings', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	await updateChannel(parsed.data.channel, parsed.data.mode);
	res.json(getStatus());
});
