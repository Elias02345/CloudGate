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

import { CreateProxyHostRequestSchema, HostAdvancedOptionsSchema } from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { audit } from '../middleware/audit.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { verifyDns } from '../services/dns-verify.js';
import { publish } from '../services/events.js';
import { deployHost, undeployHost } from '../services/host-deploy.js';

const log = childLogger('routes:hosts');
export const hostsRouter: RouterType = Router();

interface HostRow {
	id: number;
	tunnel_id: number | null;
	cf_zone_id: number | null;
	mode: string;
	protocol: string;
	hostname: string;
	forward_scheme: string;
	forward_host: string;
	forward_port: number;
	path_prefix: string;
	enabled: number;
	dns_record_id: string | null;
	edge_endpoint: string | null;
	tls_options: string;
	advanced_options: string | null;
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
		protocol: row.protocol ?? 'http',
		hostname: row.hostname,
		forward_scheme: row.forward_scheme,
		forward_host: row.forward_host,
		forward_port: row.forward_port,
		path_prefix: row.path_prefix,
		enabled: Boolean(row.enabled),
		dns_record_id: row.dns_record_id,
		edge_endpoint: safeJson(row.edge_endpoint),
		tls_options: safeJson(row.tls_options) ?? {},
		advanced_options: safeJson(row.advanced_options) ?? {},
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
	// A host belongs to the user if:
	//   - its tunnel goes through a cloudflare_accounts row owned by user, OR
	//   - its tunnel goes through a playit_accounts row owned by user, OR
	//   - it's an unbound local_nginx host (single-user MVP).
	const row = await knex<HostRow>('proxy_hosts')
		.leftJoin('tunnels', 'tunnels.id', 'proxy_hosts.tunnel_id')
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
		.where('proxy_hosts.id', hostId)
		.andWhere((b) => {
			b.where('cloudflare_accounts.user_id', userId)
				.orWhere('playit_accounts.user_id', userId)
				.orWhere((nested) => {
					nested.whereNull('cloudflare_accounts.user_id').whereNull('playit_accounts.user_id');
				});
		})
		.select('proxy_hosts.*')
		.first();
	return row ?? null;
}

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------
hostsRouter.post(
	'/',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'host.created',
		entityType: 'host',
		meta: (req) => ({ hostname: req.body?.hostname, mode: req.body?.mode }),
	}),
	async (req, res) => {
		if (!req.user) {
			res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
			return;
		}
		const parsed = CreateProxyHostRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
			return;
		}
		const input = parsed.data;
		const knex = getDb();

		// Validate the tunnel/zone exists + belongs to the user
		if (input.mode === 'cloudflare_tunnel') {
			if (!input.tunnel_id) {
				res.status(400).json({ error: 'cloudflare_tunnel mode requires tunnel_id', code: 'BAD_REQUEST' });
				return;
			}
			// Look up the tunnel — must be owned by the user via cloudflare_accounts
			// (cloudflared provider) or playit_accounts (playit provider).
			const tunnel = await knex<{ id: number; provider: string }>('tunnels')
				.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
				.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
				.where('tunnels.id', input.tunnel_id)
				.andWhere((b) => {
					b.where('cloudflare_accounts.user_id', req.user?.id).orWhere(
						'playit_accounts.user_id',
						req.user?.id
					);
				})
				.select('tunnels.id', 'tunnels.provider')
				.first();
			if (!tunnel) {
				res.status(400).json({ error: 'Tunnel not found or not yours', code: 'BAD_REQUEST' });
				return;
			}

			// Validate protocol matches the provider's capabilities.
			const protocol = input.protocol ?? 'http';
			const providerName = tunnel.provider ?? 'cloudflared';
			const supportsByProvider: Record<string, string[]> = {
				cloudflared: ['http', 'https'],
				playit: ['tcp', 'udp'],
			};
			if (!supportsByProvider[providerName]?.includes(protocol)) {
				res.status(400).json({
					error: `Tunnel uses provider '${providerName}' which does not support protocol '${protocol}'.`,
					code: 'PROTOCOL_PROVIDER_MISMATCH',
				});
				return;
			}

			// path_prefix is only meaningful for HTTP routing.
			if (protocol !== 'http' && protocol !== 'https' && input.path_prefix && input.path_prefix !== '/') {
				res.status(400).json({
					error: `path_prefix is only valid for http/https protocols (got '${protocol}').`,
					code: 'PATH_PREFIX_NOT_ALLOWED',
				});
				return;
			}

			// Zone is required for cloudflared (CNAME) and Java MC (SRV record),
			// but optional for Bedrock UDP (host_port — no DNS record).
			const needsZone = providerName === 'cloudflared' || (providerName === 'playit' && protocol === 'tcp');
			if (needsZone && !input.cf_zone_id) {
				res.status(400).json({
					error: `Protocol '${protocol}' on provider '${providerName}' requires a cf_zone_id for the DNS record.`,
					code: 'ZONE_REQUIRED',
				});
				return;
			}

			if (input.cf_zone_id) {
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
		}

		const now = new Date().toISOString();
		try {
			const insertRow: Record<string, unknown> = {
				tunnel_id: input.tunnel_id ?? null,
				cf_zone_id: input.cf_zone_id ?? null,
				mode: input.mode,
				protocol: input.protocol ?? 'http',
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
			};
			// Only include advanced_options if migration 006 has applied (column exists).
			if (await knex.schema.hasColumn('proxy_hosts', 'advanced_options')) {
				insertRow.advanced_options = JSON.stringify(input.advanced_options ?? {});
			}
			const [id] = await knex('proxy_hosts').insert(insertRow);

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
	}
);

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
		.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
		.where((b) => {
			b.where('cloudflare_accounts.user_id', req.user?.id)
				.orWhere('playit_accounts.user_id', req.user?.id)
				.orWhere((nested) => {
					nested.whereNull('cloudflare_accounts.user_id').whereNull('playit_accounts.user_id');
				});
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
// PUT /:id — edit forward target + tunnel/zone reassignment
//
// Hostname/mode are still immutable (changing those is a delete+create
// operation for sanity). tunnel_id and cf_zone_id ARE editable in 0.2.4+
// so users can recover from orphaned hosts (migration 008) and move a
// host between tunnels without rebuilding it.
// ---------------------------------------------------------------------------
const UpdateHostSchema = z.object({
	tunnel_id: z.number().int().positive().optional(),
	cf_zone_id: z.number().int().positive().optional(),
	forward_scheme: z.enum(['http', 'https']).optional(),
	forward_host: z.string().min(1).optional(),
	forward_port: z.number().int().min(1).max(65535).optional(),
	path_prefix: z.string().min(1).optional(),
	tls_options: z
		.object({
			no_tls_verify: z.boolean().optional(),
		})
		.optional(),
	advanced_options: HostAdvancedOptionsSchema.optional(),
	headers: z.record(z.string()).optional(),
});

hostsRouter.put(
	'/:id',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'host.updated',
		entityType: 'host',
		entityId: (req) => Number.parseInt(String(req.params.id ?? ''), 10) || null,
	}),
	async (req, res) => {
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
		const parsed = UpdateHostSchema.safeParse(req.body);
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
			return;
		}
		const input = parsed.data;
		const knex = getDb();

		// Detect reassignment: tunnel or zone changing means we need to
		// undeploy the host from the OLD tunnel/zone before persisting,
		// otherwise stale DNS records + ingress entries leak.
		const tunnelChanging = input.tunnel_id !== undefined && input.tunnel_id !== row.tunnel_id;
		const zoneChanging = input.cf_zone_id !== undefined && input.cf_zone_id !== row.cf_zone_id;

		if (tunnelChanging || zoneChanging) {
			// Validate the new tunnel belongs to the user. Skip when only
			// the zone changes within the same tunnel.
			if (tunnelChanging && input.tunnel_id) {
				const newTunnel = await knex<{ id: number; provider: string }>('tunnels')
					.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
					.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
					.where('tunnels.id', input.tunnel_id)
					.andWhere((b) => {
						b.where('cloudflare_accounts.user_id', req.user?.id).orWhere(
							'playit_accounts.user_id',
							req.user?.id
						);
					})
					.select('tunnels.id', 'tunnels.provider')
					.first();
				if (!newTunnel) {
					res.status(400).json({
						error: 'Target tunnel not found or not yours',
						code: 'BAD_REQUEST',
					});
					return;
				}
				const protocol = row.protocol ?? 'http';
				const supports: Record<string, string[]> = {
					cloudflared: ['http', 'https'],
					playit: ['tcp', 'udp'],
				};
				if (!supports[newTunnel.provider]?.includes(protocol)) {
					res.status(400).json({
						error: `Target tunnel uses provider '${newTunnel.provider}' which does not support this host's protocol '${protocol}'.`,
						code: 'PROTOCOL_PROVIDER_MISMATCH',
					});
					return;
				}
			}

			// Validate the new zone exists + the hostname still ends with
			// the zone's name. Zone-hostname mismatch is the most common
			// foot-shoot here.
			if (input.cf_zone_id !== undefined && input.cf_zone_id !== null) {
				const zone = await knex<{ name: string }>('cf_zones').where({ id: input.cf_zone_id }).first();
				if (!zone) {
					res.status(400).json({ error: 'Target zone not found', code: 'BAD_REQUEST' });
					return;
				}
				if (!row.hostname.endsWith(zone.name)) {
					res.status(400).json({
						error: `Hostname '${row.hostname}' does not end with zone '${zone.name}'`,
						code: 'HOSTNAME_ZONE_MISMATCH',
					});
					return;
				}
			}

			// Tear down the old deployment before mutating the row. This
			// deletes the old DNS record (using the soon-to-be-stale
			// cf_zone_id) and removes the host from the old tunnel's
			// rendered ingress.
			try {
				await undeployHost(id);
			} catch (err) {
				log.warn(
					{ err: (err as Error).message, host_id: id },
					'undeploy-before-reassign failed (continuing — dns record may leak)'
				);
			}
		}

		const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
		if (input.tunnel_id !== undefined) updates.tunnel_id = input.tunnel_id;
		if (input.cf_zone_id !== undefined) updates.cf_zone_id = input.cf_zone_id;
		if (input.forward_scheme !== undefined) updates.forward_scheme = input.forward_scheme;
		if (input.forward_host !== undefined) updates.forward_host = input.forward_host;
		if (input.forward_port !== undefined) updates.forward_port = input.forward_port;
		if (input.path_prefix !== undefined) updates.path_prefix = input.path_prefix;
		if (input.tls_options !== undefined) updates.tls_options = JSON.stringify(input.tls_options);
		if (input.headers !== undefined) updates.headers = JSON.stringify(input.headers);
		if (input.advanced_options !== undefined) {
			if (await knex.schema.hasColumn('proxy_hosts', 'advanced_options')) {
				updates.advanced_options = JSON.stringify(input.advanced_options);
			}
		}
		// Reset stale dns_record_id when zone changes — old id pointed at
		// a record we just deleted (or one in a different zone entirely).
		if (zoneChanging) updates.dns_record_id = null;
		// Clear any prior orphan-recovery last_error since we're freshly
		// re-attaching to a known tunnel.
		if (tunnelChanging) updates.last_error = null;

		await knex('proxy_hosts').where({ id }).update(updates);

		// Re-deploy so the tunnel config picks up the change (new scheme /
		// port / tunnel / zone / etc.) and the upstream probe re-runs.
		void deployHost(id).catch((err) =>
			log.warn({ err: (err as Error).message, host_id: id }, 'Re-deploy after edit failed')
		);

		const fresh = await knex<HostRow>('proxy_hosts').where({ id }).first();
		if (!fresh) {
			res.status(500).json({ error: 'host vanished after update', code: 'INTERNAL' });
			return;
		}
		res.json({ host: publicHost(fresh) });
	}
);

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
hostsRouter.delete(
	'/:id',
	requireAuth,
	requirePasswordSet,
	audit({
		action: 'host.deleted',
		entityType: 'host',
		entityId: (req) => Number.parseInt(String(req.params.id ?? ''), 10) || null,
	}),
	async (req, res) => {
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
	}
);

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
// POST /:id/redeploy — retry a failed deploy
// ---------------------------------------------------------------------------
hostsRouter.post('/:id/redeploy', requireAuth, requirePasswordSet, async (req, res) => {
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
	// Clear stale error so the UI knows the retry is in flight
	await knex('proxy_hosts').where({ id }).update({ last_error: null });
	try {
		await deployHost(id);
		res.json({ ok: true });
	} catch (err) {
		// deployHost already wrote last_error; surface the message synchronously
		res.status(502).json({
			error: (err as Error).message,
			code: 'DEPLOY_FAILED',
		});
	}
});

// ---------------------------------------------------------------------------
// GET /:id/verify-dns — query 1.1.1.1 DoH to confirm the CNAME has
// propagated. Used by the UI to show a clear DNS status badge.
// ---------------------------------------------------------------------------
hostsRouter.get('/:id/verify-dns', requireAuth, requirePasswordSet, async (req, res) => {
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
	if (row.mode !== 'cloudflare_tunnel') {
		res
			.status(400)
			.json({ error: 'verify-dns only applies to cloudflare_tunnel hosts', code: 'BAD_REQUEST' });
		return;
	}
	// Need the tunnel's CF UUID to know what the CNAME should target
	const knex = getDb();
	if (!row.tunnel_id) {
		res.status(400).json({ error: 'host has no tunnel attached', code: 'BAD_REQUEST' });
		return;
	}
	const tunnelRow = await knex<{ tunnel_id: string }>('tunnels').where({ id: row.tunnel_id }).first();
	if (!tunnelRow) {
		res.status(400).json({ error: 'tunnel not found', code: 'BAD_REQUEST' });
		return;
	}
	const expected = `${tunnelRow.tunnel_id}.cfargotunnel.com`;
	// Fast probe — single attempt, no retry; manual button click should be snappy
	const result = await verifyDns(row.hostname, expected, { attempts: 1, intervalMs: 0 });
	res.json({ hostname: row.hostname, expected, result });
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
