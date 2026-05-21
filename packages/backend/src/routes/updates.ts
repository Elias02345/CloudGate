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
import {
	getStatus,
	readLastUpdateMarker,
	readUpdateLog,
	triggerCheck,
	triggerInstall,
	updateChannel,
} from '../services/updater.js';

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

/**
 * Tail of /data/logs/update-history.log. Frontend uses this AFTER the
 * backend restart to replay what the apply-update.sh script did while
 * the backend was down.
 */
updatesRouter.get('/log', requireAuth, requirePasswordSet, async (req, res) => {
	const lines = Math.max(1, Math.min(2000, Number.parseInt(String(req.query.lines ?? '300'), 10) || 300));
	const result = await readUpdateLog(lines);
	res.json(result);
});

/**
 * Latest /data/updates/.last-update-*.json marker. Frontend reads this
 * after reconnect to confirm `succeeded` / `rolled_back` / `failed`.
 */
updatesRouter.get('/last', requireAuth, requirePasswordSet, async (_req, res) => {
	const marker = await readLastUpdateMarker();
	if (!marker) {
		res.status(404).json({ error: 'No previous update marker', code: 'NOT_FOUND' });
		return;
	}
	res.json(marker);
});
