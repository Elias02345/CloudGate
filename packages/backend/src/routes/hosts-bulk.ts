/**
 * Bulk-host import endpoint.
 *
 *   POST /api/hosts/bulk-import
 *      { hosts: [{hostname, forward_host, forward_port, forward_scheme?,
 *                  mode?, tunnel_id?, cf_zone_id?, no_tls_verify?}, ...] }
 *
 * Each row is validated independently — bad rows are reported back, good
 * rows are inserted + queued for deploy. This is intentionally separate
 * from `hosts.ts` so the bulk path stays small and the single-host route
 * keeps its zod-only validation.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import { deployHost } from '../services/host-deploy.js';

const log = childLogger('routes:hosts-bulk');
export const hostsBulkRouter: RouterType = Router();

const HOSTNAME_RX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const RowSchema = z.object({
	mode: z.enum(['cloudflare_tunnel', 'local_nginx']).default('cloudflare_tunnel'),
	hostname: z.string().regex(HOSTNAME_RX),
	forward_scheme: z.enum(['http', 'https']).default('http'),
	forward_host: z.string().min(1),
	forward_port: z.coerce.number().int().min(1).max(65535),
	path_prefix: z.string().default('/'),
	tunnel_id: z.coerce.number().int().positive().optional(),
	cf_zone_id: z.coerce.number().int().positive().optional(),
	no_tls_verify: z.coerce.boolean().optional(),
});

const BulkSchema = z.object({
	hosts: z.array(z.unknown()).min(1).max(500),
});

interface RowResult {
	row: number;
	hostname: string;
	ok: boolean;
	error?: string;
	id?: number;
}

hostsBulkRouter.post('/bulk-import', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = BulkSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Expected { hosts: [...] }', code: 'BAD_REQUEST' });
		return;
	}

	const knex = getDb();
	const results: RowResult[] = [];
	let i = 0;
	for (const raw of parsed.data.hosts) {
		i++;
		const rowParse = RowSchema.safeParse(raw);
		if (!rowParse.success) {
			results.push({
				row: i,
				hostname: (raw as { hostname?: string })?.hostname ?? '?',
				ok: false,
				error: rowParse.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
			});
			continue;
		}
		const row = rowParse.data;
		try {
			if (row.mode === 'cloudflare_tunnel') {
				if (!row.tunnel_id || !row.cf_zone_id) {
					throw new Error('cloudflare_tunnel mode requires tunnel_id and cf_zone_id');
				}
				// Validate tunnel belongs to user
				const tunnelOk = await knex('tunnels')
					.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
					.where({ 'tunnels.id': row.tunnel_id, 'cloudflare_accounts.user_id': req.user.id })
					.first();
				if (!tunnelOk) throw new Error(`tunnel #${row.tunnel_id} not found or not yours`);
				// Validate hostname-zone match
				const zone = await knex<{ name: string }>('cf_zones').where({ id: row.cf_zone_id }).first();
				if (!zone) throw new Error(`zone #${row.cf_zone_id} not found`);
				if (!row.hostname.endsWith(zone.name)) {
					throw new Error(`hostname does not end with zone (${zone.name})`);
				}
			}
			const now = new Date().toISOString();
			const [id] = await knex('proxy_hosts').insert({
				tunnel_id: row.tunnel_id ?? null,
				cf_zone_id: row.cf_zone_id ?? null,
				mode: row.mode,
				hostname: row.hostname.toLowerCase(),
				forward_scheme: row.forward_scheme,
				forward_host: row.forward_host,
				forward_port: row.forward_port,
				path_prefix: row.path_prefix,
				enabled: 1,
				tls_options: JSON.stringify({ no_tls_verify: Boolean(row.no_tls_verify) }),
				headers: '{}',
				meta: '{}',
				created_at: now,
				updated_at: now,
			});
			// Deploy async — don't block the response
			void deployHost(Number(id)).catch((err) => {
				log.warn({ err: (err as Error).message, host_id: id }, 'bulk-import deploy failed');
			});
			results.push({ row: i, hostname: row.hostname, ok: true, id: Number(id) });
		} catch (err) {
			const msg = (err as { code?: string; message?: string }).message ?? 'unknown';
			results.push({
				row: i,
				hostname: row.hostname,
				ok: false,
				error: msg.includes('UNIQUE constraint') ? 'hostname already exists' : msg,
			});
		}
	}

	const ok = results.filter((r) => r.ok).length;
	const fail = results.length - ok;
	record({
		user_id: req.user.id,
		action: 'host.bulk_imported',
		meta: { ok, fail, total: results.length },
		ip: req.ip ?? null,
	});
	log.info({ ok, fail }, 'Bulk import completed');
	res.json({ total: results.length, ok, fail, results });
});
