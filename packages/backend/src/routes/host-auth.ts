/**
 * Visitor authentication for a host (issue #99). Mounted under /api/hosts.
 *
 *   GET    /:id/auth             — current state (never returns secrets)
 *   POST   /:id/auth/totp-setup  — fresh TOTP secret + QR (nothing stored yet)
 *   PUT    /:id/auth             — set username / password / TOTP, then redeploy
 *   DELETE /:id/auth             — remove protection, then redeploy
 *
 * Protection works by routing the host through the built-in auth gateway
 * (services/host-gateway.ts), so it only applies to cloudflared (HTTP) hosts.
 */

import { Router, type Router as RouterType } from 'express';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { z } from 'zod';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import {
	HostAuthInputError,
	type HostAuthRow,
	getHostAuth,
	removeHostAuth,
	restoreHostAuth,
	saveHostAuth,
	summarise,
} from '../services/host-auth.js';
import { deployHost } from '../services/host-deploy.js';
import { ownsHost } from './hosts.js';

const log = childLogger('routes:host-auth');
export const hostAuthRouter: RouterType = Router();

hostAuthRouter.use('/:id/auth', requireAuth, requirePasswordSet);

const SaveSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(64)
		.regex(/^[A-Za-z0-9._@+-]+$/, 'Only letters, digits and . _ @ + - are allowed'),
	password: z.string().min(12).max(256).optional(),
	totp: z
		.union([z.null(), z.object({ secret: z.string().min(16).max(64), code: z.string().regex(/^\d{6}$/) })])
		.optional(),
});

/** Returns the host, or sends the error response and returns null. */
async function loadEligibleHost(
	req: import('express').Request,
	res: import('express').Response
): Promise<{ id: number; hostname: string } | null> {
	const id = Number.parseInt(String(req.params.id), 10);
	if (!req.user || !Number.isInteger(id)) {
		res.status(400).json({ error: 'Invalid host id', code: 'BAD_REQUEST' });
		return null;
	}
	const host = await ownsHost(req.user.id, id);
	if (!host) {
		res.status(404).json({ error: 'Host not found', code: 'NOT_FOUND' });
		return null;
	}
	const protocol = host.protocol ?? 'http';
	let provider = 'cloudflared';
	if (host.tunnel_id) {
		const t = await getDb()('tunnels').where({ id: host.tunnel_id }).select('provider').first();
		provider = (t?.provider as string | null) ?? 'cloudflared';
	}
	if (
		host.mode !== 'cloudflare_tunnel' ||
		provider !== 'cloudflared' ||
		(protocol !== 'http' && protocol !== 'https')
	) {
		res.status(400).json({
			error: 'Host authentication is available for HTTP(S) hosts on a Cloudflare tunnel only.',
			code: 'UNSUPPORTED_HOST',
		});
		return null;
	}
	return { id: host.id, hostname: host.hostname };
}

async function redeploy(hostId: number): Promise<string | null> {
	try {
		await deployHost(hostId);
		return null;
	} catch (err) {
		log.warn({ hostId, err: (err as Error).message }, 'redeploy after host-auth change failed');
		return (err as Error).message;
	}
}

async function rollback(hostId: number, previous: HostAuthRow | null): Promise<void> {
	await restoreHostAuth(hostId, previous);
	// Best effort: re-render so cloudflared and the DB agree again.
	await redeploy(hostId);
}

hostAuthRouter.get('/:id/auth', async (req, res) => {
	const host = await loadEligibleHost(req, res);
	if (!host) return;
	res.json(summarise(await getHostAuth(host.id)));
});

hostAuthRouter.post('/:id/auth/totp-setup', async (req, res) => {
	const host = await loadEligibleHost(req, res);
	if (!host) return;
	const secret = authenticator.generateSecret();
	const label = (await getHostAuth(host.id))?.username ?? host.hostname;
	const otpauthUrl = authenticator.keyuri(label, host.hostname, secret);
	res.json({ secret, otpauth_url: otpauthUrl, qr_code_data_url: await qrcode.toDataURL(otpauthUrl) });
});

hostAuthRouter.put('/:id/auth', async (req, res) => {
	const host = await loadEligibleHost(req, res);
	if (!host) return;
	const parsed = SaveSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const previous = await getHostAuth(host.id);
	try {
		await saveHostAuth(host.id, {
			username: parsed.data.username,
			...(parsed.data.password ? { password: parsed.data.password } : {}),
			...(parsed.data.totp !== undefined ? { totp: parsed.data.totp } : {}),
		});
	} catch (err) {
		if (err instanceof HostAuthInputError) {
			res.status(400).json({ error: err.message, code: 'BAD_REQUEST' });
			return;
		}
		throw err;
	}
	record({
		user_id: req.user?.id ?? null,
		action: 'host.auth_updated',
		meta: { host_id: host.id },
		ip: req.ip ?? null,
	});
	const deployError = await redeploy(host.id);
	if (deployError) {
		// cloudflared still has the old routing. Keeping the new credentials
		// would show "protected" for a host that is in fact open (or, for a
		// change, mismatched), so put the previous state back.
		await rollback(host.id, previous);
		res.status(502).json({
			error: `The tunnel could not be updated, so nothing was changed: ${deployError}`,
			code: 'DEPLOY_FAILED',
		});
		return;
	}
	res.json({ ...summarise(await getHostAuth(host.id)), deploy_error: null });
});

hostAuthRouter.delete('/:id/auth', async (req, res) => {
	const host = await loadEligibleHost(req, res);
	if (!host) return;
	const previous = await getHostAuth(host.id);
	await removeHostAuth(host.id);
	record({
		user_id: req.user?.id ?? null,
		action: 'host.auth_removed',
		meta: { host_id: host.id },
		ip: req.ip ?? null,
	});
	const deployError = await redeploy(host.id);
	if (deployError) {
		// Without this the gateway would find no credentials and answer 404
		// for a host cloudflared still routes through it.
		await rollback(host.id, previous);
		res.status(502).json({
			error: `The tunnel could not be updated, so nothing was changed: ${deployError}`,
			code: 'DEPLOY_FAILED',
		});
		return;
	}
	res.json({ enabled: false, deploy_error: null });
});
