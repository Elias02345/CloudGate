/**
 * Tunnel routes.
 *
 *   POST   /            — create a tunnel (calls CF API, persists, starts daemon)
 *   GET    /            — list tunnels
 *   DELETE /:id         — delete from CF + locally + stop daemon
 *   POST   /:id/restart — stop + start daemon
 *   GET    /:id/logs    — last N daemon log lines
 */

import { randomBytes } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { getAccountById, decryptCredentials } from '../services/cf-account.js';
import { CloudflareApiError, clientFor } from '../services/cloudflare-client.js';
import { encryptJson } from '../services/crypto.js';
import { deployHost } from '../services/host-deploy.js';
import {
	logsOf as managerLogs,
	reloadTunnel,
	startTunnel,
	statusOf as managerStatus,
	stopTunnel,
} from '../services/tunnel-manager.js';
import { readCurrentConfig } from '../services/tunnel-config-writer.js';

const log = childLogger('routes:tunnels');
export const tunnelsRouter: RouterType = Router();

const CreateSchema = z.object({
	cloudflare_account_id: z.number().int().positive(),
	name: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[a-zA-Z0-9-_]+$/),
});

interface TunnelRow {
	id: number;
	cloudflare_account_id: number;
	tunnel_id: string;
	name: string;
	account_tag: string;
	credentials_path: string;
	status: string;
	last_status_at: string | null;
	created_at: string;
}

function publicTunnel(row: TunnelRow): {
	id: number;
	cloudflare_account_id: number;
	tunnel_id: string;
	name: string;
	account_tag: string;
	status: string;
	live_status: string;
	last_status_at: string | null;
	created_at: string;
} {
	return {
		id: row.id,
		cloudflare_account_id: row.cloudflare_account_id,
		tunnel_id: row.tunnel_id,
		name: row.name,
		account_tag: row.account_tag,
		status: row.status,
		live_status: managerStatus(row.id),
		last_status_at: row.last_status_at,
		created_at: row.created_at,
	};
}

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
tunnelsRouter.post('/', requireAuth, requirePasswordSet, audit({
	action: 'tunnel.created',
	entityType: 'tunnel',
	meta: (req) => ({ name: req.body?.name }),
}), async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = CreateSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const { cloudflare_account_id, name } = parsed.data;

	const account = await getAccountById(cloudflare_account_id, req.user.id);
	if (!account) {
		res.status(404).json({ error: 'Cloudflare account not found', code: 'NOT_FOUND' });
		return;
	}

	const creds = decryptCredentials(account);
	if (creds.type !== 'api_token') {
		res.status(400).json({ error: 'Tunnel create requires api_token auth', code: 'CF_UNSUPPORTED_AUTH' });
		return;
	}

	const tunnelSecret = randomBytes(32).toString('base64');
	try {
		const cf = clientFor(creds.token);
		// SDK call — Cloudflare returns the created tunnel object with .id (UUID).
		// In cloudflare@4.x the cfd_tunnel endpoints live under .cloudflared,
		// not directly on .tunnels.
		// biome-ignore lint/suspicious/noExplicitAny: SDK types are loose around tunnel_secret param
		const created = (await (cf.zeroTrust.tunnels.cloudflared as any).create({
			account_id: account.account_tag,
			name,
			tunnel_secret: tunnelSecret,
			config_src: 'local',
		})) as { id: string; name: string };

		const knex = getDb();
		const now = new Date().toISOString();
		const encryptedSecret = encryptJson({ type: 'tunnel', secret: tunnelSecret });
		const [id] = await knex('tunnels').insert({
			cloudflare_account_id: account.id,
			tunnel_id: created.id,
			name: created.name,
			account_tag: account.account_tag,
			encrypted_tunnel_secret: encryptedSecret,
			credentials_path: '', // filled in on first startTunnel
			status: 'starting',
			last_status_at: now,
			created_at: now,
		});

		await startTunnel(Number(id));
		const row = await knex<TunnelRow>('tunnels').where({ id }).first();
		if (!row) throw new Error('inserted tunnel disappeared');
		log.info({ id, name: created.name, tunnel_id: created.id }, 'Tunnel created + started');
		res.status(201).json({ tunnel: publicTunnel(row) });
	} catch (err) {
		if (err instanceof CloudflareApiError) {
			res.status(err.status === 401 ? 400 : 502).json({ error: err.message, code: err.code });
			return;
		}
		const e = err as { status?: number; message?: string; code?: string };
		log.error({ err: e.message }, 'Tunnel create failed');
		res.status(e.status ?? 500).json({
			error: e.message ?? 'Tunnel creation failed',
			code: e.code ?? 'TUNNEL_CREATE_FAILED',
		});
	}
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
tunnelsRouter.get('/', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const knex = getDb();
	const rows = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'cloudflare_accounts.user_id': req.user.id })
		.select(
			'tunnels.id',
			'tunnels.cloudflare_account_id',
			'tunnels.tunnel_id',
			'tunnels.name',
			'tunnels.account_tag',
			'tunnels.credentials_path',
			'tunnels.status',
			'tunnels.last_status_at',
			'tunnels.created_at'
		);
	res.json({ tunnels: rows.map(publicTunnel) });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
tunnelsRouter.delete('/:id', requireAuth, requirePasswordSet, audit({
	action: 'tunnel.deleted',
	entityType: 'tunnel',
	entityId: (req) => Number.parseInt(String(req.params.id ?? ''), 10) || null,
}), async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	if (!Number.isFinite(id)) {
		res.status(400).json({ error: 'Invalid id', code: 'BAD_REQUEST' });
		return;
	}
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'tunnels.id': id, 'cloudflare_accounts.user_id': req.user.id })
		.select('tunnels.*')
		.first();
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	// Stop daemon first
	await stopTunnel(id);

	// Best-effort CF delete
	const account = await getAccountById(row.cloudflare_account_id, req.user.id);
	if (account) {
		try {
			const creds = decryptCredentials(account);
			if (creds.type === 'api_token') {
				const cf = clientFor(creds.token);
				// biome-ignore lint/suspicious/noExplicitAny: SDK types
				await (cf.zeroTrust.tunnels.cloudflared as any).delete(row.tunnel_id, {
					account_id: row.account_tag,
				});
			}
		} catch (err) {
			log.warn({ err: (err as Error).message, tunnel_id: row.tunnel_id }, 'CF tunnel delete failed (continuing)');
		}
	}

	await knex('tunnels').where({ id }).delete();
	res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /:id/restart
// ---------------------------------------------------------------------------
tunnelsRouter.post('/:id/restart', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'tunnels.id': id, 'cloudflare_accounts.user_id': req.user.id })
		.select('tunnels.id')
		.first();
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}
	await stopTunnel(id);
	await startTunnel(id);
	res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /:id/logs
// ---------------------------------------------------------------------------
tunnelsRouter.get('/:id/logs', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'tunnels.id': id, 'cloudflare_accounts.user_id': req.user.id })
		.select('tunnels.id')
		.first();
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}
	res.json({ logs: managerLogs(id) });
});

// ---------------------------------------------------------------------------
// GET /:id/config — the actual rendered /data/cloudflared/config.yml
// What cloudflared is currently using. Critical for diagnosing
// "DNS works but request 404s" type bugs.
// ---------------------------------------------------------------------------
tunnelsRouter.get('/:id/config', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'tunnels.id': id, 'cloudflare_accounts.user_id': req.user.id })
		.select('tunnels.id', 'tunnels.tunnel_id', 'tunnels.name')
		.first();
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	// Also list the hosts this tunnel SHOULD have, so the user can
	// cross-check the rendered config against expectation.
	const hosts = await knex('proxy_hosts')
		.where({ tunnel_id: id, mode: 'cloudflare_tunnel' })
		.select('id', 'hostname', 'forward_scheme', 'forward_host', 'forward_port', 'enabled', 'last_deployed_at', 'last_error');

	const yaml = await readCurrentConfig();
	res.json({
		tunnel: { id: row.id, tunnel_id: row.tunnel_id, name: row.name },
		hosts,
		yaml,
	});
});

// ---------------------------------------------------------------------------
// POST /:id/redeploy-all — force-rerender config.yml + redeploy every host
// of this tunnel. Use when the ingress list got out of sync (e.g. a
// previous deploy crashed before reloadTunnel was called).
// ---------------------------------------------------------------------------
tunnelsRouter.post('/:id/redeploy-all', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.where({ 'tunnels.id': id, 'cloudflare_accounts.user_id': req.user.id })
		.select('tunnels.id')
		.first();
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	const hosts = await knex('proxy_hosts')
		.where({ tunnel_id: id, mode: 'cloudflare_tunnel' })
		.select('id', 'hostname');

	let ok = 0;
	let failed = 0;
	const errors: Array<{ hostname: string; error: string }> = [];

	// Render the config + send SIGHUP once first — this re-applies the
	// current DB state to cloudflared. Cheap.
	try {
		await reloadTunnel(id);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'redeploy-all: reload failed (continuing)');
	}

	// Then re-deploy each host so DNS records get re-created if missing.
	for (const host of hosts) {
		try {
			await deployHost(host.id);
			ok++;
		} catch (err) {
			failed++;
			errors.push({ hostname: host.hostname, error: (err as Error).message });
		}
	}

	res.json({ ok, failed, errors });
});
