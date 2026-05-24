/**
 * Tunnel routes.
 *
 *   POST   /            — create a tunnel (provider-aware)
 *   GET    /            — list tunnels owned by user (cloudflared + playit)
 *   DELETE /:id         — stop daemon + provider-specific cleanup
 *   POST   /:id/restart — stop + start
 *   GET    /:id/logs    — last N daemon log lines
 *   GET    /:id/config  — rendered cloudflared yaml + host cross-check
 *   POST   /:id/redeploy-all — re-render config + redeploy all hosts
 */

import { randomBytes } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { CreateTunnelRequestSchema, type TunnelProviderName } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { getAccountById, decryptCredentials } from '../services/cf-account.js';
import { CloudflareApiError, clientFor } from '../services/cloudflare-client.js';
import { encryptJson } from '../services/crypto.js';
import { deployHost } from '../services/host-deploy.js';
import { getAccountById as getPlayitAccountById } from '../services/playit-account.js';
import {
	logsOf as managerLogs,
	reloadTunnel,
	startTunnel,
	statusOf as managerStatus,
	stopTunnel,
} from '../services/tunnel-manager.js';
import { readCurrentConfig } from '../services/tunnel-providers/cloudflared/config-writer.js';

const log = childLogger('routes:tunnels');
export const tunnelsRouter: RouterType = Router();

interface TunnelRow {
	id: number;
	cloudflare_account_id: number | null;
	playit_account_id: number | null;
	provider: string | null;
	tunnel_id: string;
	name: string;
	account_tag: string | null;
	credentials_path: string | null;
	provider_meta: string | null;
	status: string;
	last_status_at: string | null;
	created_at: string;
}

function publicTunnel(row: TunnelRow): {
	id: number;
	provider: TunnelProviderName;
	cloudflare_account_id: number | null;
	playit_account_id: number | null;
	tunnel_id: string;
	name: string;
	account_tag: string | null;
	status: string;
	live_status: string;
	last_status_at: string | null;
	created_at: string;
} {
	const providerName = (row.provider ?? 'cloudflared') as TunnelProviderName;
	return {
		id: row.id,
		provider: providerName,
		cloudflare_account_id: row.cloudflare_account_id,
		playit_account_id: row.playit_account_id,
		tunnel_id: row.tunnel_id,
		name: row.name,
		account_tag: row.account_tag,
		status: row.status,
		live_status: managerStatus(row.id, providerName),
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
	meta: (req) => ({ name: req.body?.name, provider: req.body?.provider ?? 'cloudflared' }),
}), async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = CreateTunnelRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}

	if (parsed.data.provider === 'playit') {
		await createPlayitTunnel(req, res, parsed.data);
		return;
	}
	await createCloudflaredTunnel(req, res, parsed.data);
});

async function createCloudflaredTunnel(
	req: import('express').Request,
	res: import('express').Response,
	input: { cloudflare_account_id?: number; name: string },
): Promise<void> {
	if (!input.cloudflare_account_id) {
		res.status(400).json({ error: 'cloudflared tunnels require cloudflare_account_id', code: 'BAD_REQUEST' });
		return;
	}
	const account = await getAccountById(input.cloudflare_account_id, req.user!.id);
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
		// biome-ignore lint/suspicious/noExplicitAny: SDK types are loose around tunnel_secret param
		const created = (await (cf.zeroTrust.tunnels.cloudflared as any).create({
			account_id: account.account_tag,
			name: input.name,
			tunnel_secret: tunnelSecret,
			config_src: 'local',
		})) as { id: string; name: string };

		const knex = getDb();
		const now = new Date().toISOString();
		const encryptedSecret = encryptJson({ type: 'tunnel', secret: tunnelSecret });
		const [id] = await knex('tunnels').insert({
			cloudflare_account_id: account.id,
			provider: 'cloudflared',
			provider_meta: '{}',
			tunnel_id: created.id,
			name: created.name,
			account_tag: account.account_tag,
			encrypted_tunnel_secret: encryptedSecret,
			credentials_path: '',
			status: 'starting',
			last_status_at: now,
			created_at: now,
		});

		await startTunnel(Number(id));
		const row = await knex<TunnelRow>('tunnels').where({ id }).first();
		if (!row) throw new Error('inserted tunnel disappeared');
		log.info({ id, name: created.name, tunnel_id: created.id }, 'cloudflared tunnel created + started');
		res.status(201).json({ tunnel: publicTunnel(row) });
	} catch (err) {
		if (err instanceof CloudflareApiError) {
			res.status(err.status === 401 ? 400 : 502).json({ error: err.message, code: err.code });
			return;
		}
		const e = err as { status?: number; message?: string; code?: string };
		log.error({ err: e.message }, 'cloudflared tunnel create failed');
		res.status(e.status ?? 500).json({
			error: e.message ?? 'Tunnel creation failed',
			code: e.code ?? 'TUNNEL_CREATE_FAILED',
		});
	}
}

async function createPlayitTunnel(
	req: import('express').Request,
	res: import('express').Response,
	input: { playit_account_id?: number; name: string },
): Promise<void> {
	if (!input.playit_account_id) {
		res.status(400).json({ error: 'playit tunnels require playit_account_id', code: 'BAD_REQUEST' });
		return;
	}
	const account = await getPlayitAccountById(input.playit_account_id, req.user!.id);
	if (!account) {
		res.status(404).json({ error: 'Playit account not found', code: 'NOT_FOUND' });
		return;
	}

	const knex = getDb();
	const now = new Date().toISOString();
	// Playit "tunnel" rows are wrappers around an account — the actual port
	// mappings get created via addHost() per-host. tunnel_id is a synthetic
	// identifier we generate so cross-table joins work; no Playit API call.
	const playitTunnelId = `playit-${account.id}-${Date.now().toString(36)}`;
	const meta = { playit_account_id: account.id, hosts: {} };
	const [id] = await knex('tunnels').insert({
		cloudflare_account_id: null,
		playit_account_id: account.id,
		provider: 'playit',
		provider_meta: JSON.stringify(meta),
		tunnel_id: playitTunnelId,
		name: input.name,
		account_tag: null,
		encrypted_tunnel_secret: null,
		credentials_path: null,
		status: 'starting',
		last_status_at: now,
		created_at: now,
	});

	try {
		await startTunnel(Number(id));
	} catch (err) {
		log.warn({ err: (err as Error).message, id }, 'Playit tunnel start failed (recording but continuing)');
	}

	const row = await knex<TunnelRow>('tunnels').where({ id }).first();
	if (!row) throw new Error('inserted tunnel disappeared');
	log.info({ id, name: input.name, account_id: account.id }, 'playit tunnel created + started');
	res.status(201).json({ tunnel: publicTunnel(row) });
}

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
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
		.where((b) => {
			b.where('cloudflare_accounts.user_id', req.user!.id).orWhere('playit_accounts.user_id', req.user!.id);
		})
		.select(
			'tunnels.id',
			'tunnels.cloudflare_account_id',
			'tunnels.playit_account_id',
			'tunnels.provider',
			'tunnels.tunnel_id',
			'tunnels.name',
			'tunnels.account_tag',
			'tunnels.credentials_path',
			'tunnels.provider_meta',
			'tunnels.status',
			'tunnels.last_status_at',
			'tunnels.created_at',
		);
	res.json({ tunnels: rows.map(publicTunnel) });
});

// Helper: find tunnel by id ensuring the user owns it (via either provider's account).
async function findOwnedTunnel(userId: number, id: number): Promise<TunnelRow | null> {
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels')
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
		.where('tunnels.id', id)
		.andWhere((b) => {
			b.where('cloudflare_accounts.user_id', userId).orWhere('playit_accounts.user_id', userId);
		})
		.select('tunnels.*')
		.first();
	return row ?? null;
}

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
	const row = await findOwnedTunnel(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	// Stop daemon first (provider-aware)
	try {
		await stopTunnel(id);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'tunnel stop failed (continuing)');
	}

	// Provider-specific upstream cleanup
	if (row.provider === 'cloudflared' && row.cloudflare_account_id) {
		const account = await getAccountById(row.cloudflare_account_id, req.user.id);
		if (account) {
			try {
				const creds = decryptCredentials(account);
				if (creds.type === 'api_token' && row.account_tag) {
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
	}
	// Playit: no upstream delete needed — the agent itself is shared, and
	// per-host port mappings get deleted via undeployHost when the user
	// removes their hosts.

	const knex = getDb();
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
	const row = await findOwnedTunnel(req.user.id, id);
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
	const row = await findOwnedTunnel(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}
	res.json({ logs: managerLogs(id, 200, (row.provider ?? 'cloudflared') as TunnelProviderName) });
});

// ---------------------------------------------------------------------------
// GET /:id/config — cloudflared only; Playit returns provider_meta snapshot
// ---------------------------------------------------------------------------
tunnelsRouter.get('/:id/config', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await findOwnedTunnel(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	const knex = getDb();
	const hosts = await knex('proxy_hosts')
		.where({ tunnel_id: id, mode: 'cloudflare_tunnel' })
		.select(
			'id',
			'hostname',
			'protocol',
			'forward_scheme',
			'forward_host',
			'forward_port',
			'enabled',
			'edge_endpoint',
			'last_deployed_at',
			'last_error',
		);

	const provider = (row.provider ?? 'cloudflared') as TunnelProviderName;
	if (provider === 'cloudflared') {
		const yaml = await readCurrentConfig();
		res.json({
			tunnel: { id: row.id, tunnel_id: row.tunnel_id, name: row.name, provider },
			hosts,
			yaml,
		});
		return;
	}

	// Playit: surface the provider_meta JSON for transparency.
	res.json({
		tunnel: { id: row.id, tunnel_id: row.tunnel_id, name: row.name, provider },
		hosts,
		provider_meta: safeJson(row.provider_meta),
	});
});

function safeJson(s: string | null): unknown {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// POST /:id/redeploy-all
// ---------------------------------------------------------------------------
tunnelsRouter.post('/:id/redeploy-all', requireAuth, requirePasswordSet, async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = Number.parseInt(String(req.params.id ?? ''), 10);
	const row = await findOwnedTunnel(req.user.id, id);
	if (!row) {
		res.status(404).json({ error: 'Tunnel not found', code: 'NOT_FOUND' });
		return;
	}

	const knex = getDb();
	const hosts = await knex('proxy_hosts')
		.where({ tunnel_id: id, mode: 'cloudflare_tunnel' })
		.select('id', 'hostname');

	let ok = 0;
	let failed = 0;
	const errors: Array<{ hostname: string; error: string }> = [];

	try {
		await reloadTunnel(id);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'redeploy-all: reload failed (continuing)');
	}

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

// The UpdateHostSchema still applies to PUT /:id but we want it self-contained;
// re-export the unused z so eslint doesn't flag the import elsewhere.
void z;
