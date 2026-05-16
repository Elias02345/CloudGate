/**
 * ACME cert acquisition endpoint.
 *
 *   POST /api/acme/issue   { hostname, staging?: bool }
 *
 * Triggers an immediate cert issuance for a hostname owned by the user.
 * Used by the host form's "Acquire cert" button after creating a
 * local_nginx host. Renewals happen automatically via the cron in acme.ts.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { acquireCert } from '../services/acme.js';
import { writeHostConfig } from '../services/nginx-config.js';

const log = childLogger('routes:acme');
export const acmeRouter: RouterType = Router();

const IssueSchema = z.object({
	hostname: z.string().min(3),
	staging: z.boolean().optional(),
});

acmeRouter.post('/issue', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = IssueSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST' });
		return;
	}
	const { hostname, staging } = parsed.data;

	const knex = getDb();
	const host = await knex<{
		id: number;
		hostname: string;
		forward_scheme: string;
		forward_host: string;
		forward_port: number;
		path_prefix: string;
		tls_options: string;
		meta: string;
	}>('proxy_hosts')
		.where({ hostname, mode: 'local_nginx' })
		.first();
	if (!host) {
		res.status(404).json({ error: 'No local_nginx host with that hostname', code: 'NOT_FOUND' });
		return;
	}

	try {
		const result = await acquireCert(hostname, { staging });
		const meta: Record<string, unknown> = (() => {
			try {
				return typeof host.meta === 'string' ? JSON.parse(host.meta) : {};
			} catch {
				return {};
			}
		})();
		meta.cert_path = result.cert_path;
		meta.cert_key_path = result.key_path;
		meta.cert_expires_at = result.expires_at;

		await knex('proxy_hosts')
			.where({ id: host.id })
			.update({ meta: JSON.stringify(meta), updated_at: new Date().toISOString() });

		// Re-render nginx config with cert paths
		const tls = (() => {
			try {
				return typeof host.tls_options === 'string' ? JSON.parse(host.tls_options) : {};
			} catch {
				return {};
			}
		})() as { no_tls_verify?: boolean };

		await writeHostConfig({
			id: host.id,
			hostname: host.hostname,
			forward_scheme: host.forward_scheme,
			forward_host: host.forward_host,
			forward_port: host.forward_port,
			path_prefix: host.path_prefix,
			no_tls_verify: Boolean(tls.no_tls_verify),
			cert_path: result.cert_path,
			cert_key_path: result.key_path,
		});

		log.info({ hostname, expires: result.expires_at }, 'Cert issued + nginx reloaded');
		res.json({ ok: true, expires_at: result.expires_at });
	} catch (err) {
		const msg = (err as Error).message;
		log.warn({ hostname, err: msg }, 'ACME issue failed');
		res.status(502).json({ error: msg, code: 'ACME_FAILED' });
	}
});
