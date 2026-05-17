/**
 * Proxy-host CRUD routes.
 *
 *   POST   /            — add host (then deploy async)
 *   GET    /            — list all hosts for current user
 *   GET    /:id         — single host
 *   PUT    /:id         — edit + redeploy
 *   DELETE /:id         — undeploy + remove
 *   POST   /:id/toggle  — flip enabled flag + redeploy/undeploy
 *   GET    /:id/test    — HEAD request against the hostname to verify reachability
 */

import { Router, type Router as RouterType } from 'express';
import { CreateProxyHostRequestSchema } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { deployHost, undeployHost } from '../services/host-deploy.js';
import { publish } from '../services/events.js';

const log = childLogger('routes:hosts');
export const hostsRouter: RouterType = Router();

interface HostRow {
	id: number;
	tunnel_id: number | null;
	cf_zone_id: number | null;
	mode: string;
	hostname: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	path_prefix: string;
	enabled: number;
	dns_record_id: string | null;
	tls_options: string;
	headers: string;
	meta: string;
	last_deployed_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

function publicHost(row: HostRow): Record<string, unknown> {
	return {
		id: row.id,
		tunnel_id: row.tunnel_id,
		cf_zone_id: row.cf_zone_id,
		mode: row.mode,
		hostname: row.hostname,
		forward_scheme: row.forward_scheme,
		forward_host: row.forward_host,
		forward_port: row.forward_port,
		path_prefix: row.path_prefix,
		enabled: Boolean(row.enabled),
		dns_record_id: row.dns_record_id,
		tls_options: safeJson(row.tls_options) ?? {},
		headers: safeJson(row.headers) ?? {},
		meta: safeJson(row.meta) ?? {},
		last_deployed_at: row.last_deployed_at,
		last_error: row.last_error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function safeJson(s: string | null | undefined): unknown {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

async function ownsHost(userId: number, hostId: number): Promise<HostRow | null> {
	const knex = getDb();
	// Host either via tunnel→cf_account→user, or via cf_zone→cf_account→user (for local_nginx with cf_zone),
	// or for local_nginx with no cf binding we just check the user is admin (single-user MVP).
	const row = await knex<HostRow>('proxy_hosts')
		.leftJoin('tunnels', 'tunnels.id', 'proxy_hosts.tunnel_id')
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where('proxy_hosts.id', hostId)
		.andWhere((b) => {
			b.where('cloudflare_accounts.user_id', userId).orWhereNull('cloudflare_accounts.user_id');
		})
		.select('proxy_hosts.*')
		.first();
	return row ?? null;
}

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
hostsRouter.post('/', requireAuth, requirePasswordSet, audit({
	action: 'host.created',
	entityType: 'host',
	meta: (req) => ({ hostname: req.body?.hostname, mode: req.body?.mode }),
}), async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = CreateProxyHostRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const input = parsed.data;
	const knex = getDb();

	// Validate the tunnel/zone exists + belongs to the user
	if (input.mode === 'cloudflare_tunnel') {
		if (!input.tunnel_id || !input.cf_zone_id) {
			res.status(400).json({ error: 'cloudflare_tunnel mode requires tunnel_id and cf_zone_id', code: 'BAD_REQUEST' });
			return;
		}
		const ok = await knex('tunnels')
			.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
			.where({ 'tunnels.id': input.tunnel_id, 'cloudflare_accounts.user_id': req.user.id })
			.first();
		if (!ok) {
			res.status(400).json({ error: 'Tunnel not found or not yours', code: 'BAD_REQUEST' });
			return;
		}
		const zone = await knex<{ name: string }>('cf_zones').where({ id: input.cf_zone_id }).first();
		if (!zone) {
			res.status(400).json({ error: 'Zone not found', code: 'BAD_REQUEST' });
			return;
		}
		if (!input.hostname.endsWith(zone.name)) {
			res.status(400).json({
				error: `Hostname must end with the chosen zone (${zone.name})`,
				code: 'HOSTNAME_ZONE_MISMATCH',
			});
			return;
		}
	}

	const now = new Date().toISOString();
	try {
		const [id] = await knex('proxy_hosts').insert({
			tunnel_id: input.tunnel_id ?? null,
			cf_zone_id: input.cf_zone_id ?? null,
			mode: input.mode,
			hostname: input.hostname.toLowerCase(),
			forward_scheme: input.forward_scheme,
			forward_host: input.forward_host,
			forward_port: input.forward_port,
			path_prefix: input.path_prefix ?? '/',
			enabled: 1,
			tls_options: JSON.stringify(input.tls_options ?? {}),
			headers: JSON.stringify(input.headers ?? {}),
			meta: '{}',
			created_at: now,
			updated_at: now,
		});

		// Deploy async — don't block the response
		void deployHost(Number(id)).catch((err) =>
			log.warn({ err: (err as Error).message, host_id: id }, 'Initial deploy failed')
		);

		const row = await knex<HostRow>('proxy_hosts').where({ id }).first();
		if (!row) throw new Error('inserted host disappeared');
		res.status(201).json({ host: publicHost(row) });
	} catch (err) {
		// SQLite unique-violation on hostname
		const msg = (err as { code?: string; message?: string }).message ?? '';
		if (msg.includes('UNIQUE constraint')) {
			res.status(409).json({ error: 'Hostname already exists', code: 'CONFLICT' });
			return;
		}
		throw err;
	}
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
hostsRouter.get('/', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const knex = getDb();
	const rows = await knex<HostRow>('proxy_hosts')
		.leftJoin('tunnels', 'tunnels.id', 'proxy_hosts.tunnel_id')
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where((b) => {
			b.where('cloudflare_accounts.user_id', req.user!.id).orWhereNull('cloudflare_accounts.user_id');
		})
		.select('proxy_hosts.*')
		.orderBy('proxy_hosts.hostname');
	res.json({ hosts: rows.map(publicHost) });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
hostsRouter.get('/:id', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await ownsHost(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Host not found', code: 'NOT_FOUND' });
		return;
	}
	res.json({ host: publicHost(row) });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
hostsRouter.delete('/:id', requireAuth, requirePasswordSet, audit({
	action: 'host.deleted',
	entityType: 'host',
	entityId: (req) => Number.parseInt(String(req.params.id ?? ''), 10) || null,
}), async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await ownsHost(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Host not found', code: 'NOT_FOUND' });
		return;
	}
	await undeployHost(id);
	const knex = getDb();
	await knex('proxy_hosts').where({ id }).delete();
	publish('host.deleted', { id, hostname: row.hostname });
	res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /:id/toggle
// ---------------------------------------------------------------------------
hostsRouter.post('/:id/toggle', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await ownsHost(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Host not found', code: 'NOT_FOUND' });
		return;
	}
	const knex = getDb();
	const newVal = row.enabled ? 0 : 1;
	await knex('proxy_hosts').where({ id }).update({ enabled: newVal, updated_at: new Date().toISOString() });

	// Re-deploy / undeploy
	if (newVal === 1) {
		void deployHost(id).catch((err) =>
			log.warn({ err: (err as Error).message, host_id: id }, 'Re-enable deploy failed')
		);
	} else if (row.tunnel_id) {
		// Just rerender config without enabled host
		void undeployHost(id).catch(() => null);
	}

	publish('host.toggled', { id, enabled: Boolean(newVal) });
	res.json({ enabled: Boolean(newVal) });
});

// ---------------------------------------------------------------------------
// GET /:id/test
// ---------------------------------------------------------------------------
hostsRouter.get('/:id/test', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await ownsHost(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Host not found', code: 'NOT_FOUND' });
		return;
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const probeRes = await fetch(`https://${row.hostname}/`, { method: 'HEAD', signal: controller.signal });
		clearTimeout(timer);
		res.json({ status: probeRes.status, ok: probeRes.ok });
	} catch (err) {
		res.status(200).json({ reachable: false, error: (err as Error).message });
	}
});
