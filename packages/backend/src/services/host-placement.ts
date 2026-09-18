/**
 * Placement rules for a proxy host: does this tunnel belong to the caller, can
 * its provider carry this protocol, and does the hostname sit in the zone that
 * will hold its DNS record?
 *
 * These rules used to live inside the POST /api/hosts handler, which meant
 * they applied to exactly one of the three ways a row reaches `proxy_hosts`.
 * The bulk importer and the AI assistant's `create_host` both wrote rows that
 * the form would have rejected — surfacing much later as an opaque deploy
 * failure. `routes/hosts-bulk.ts` already carries a comment warning that a
 * second path in must not be the softer one; this module is what makes that
 * enforceable rather than aspirational.
 *
 * Field-shape validation (hostname characters, forward_host, path_prefix) is a
 * separate concern and lives in @cloudgate/shared, applied by each route's Zod
 * schema. This module only answers questions that need the database.
 */

import { getDb } from '../db/db.js';

export interface PlacementProblem {
	error: string;
	/** Stable code the HTTP layer returns verbatim. */
	code: string;
}

export interface PlacementInput {
	mode: string;
	hostname: string;
	protocol?: string | undefined;
	path_prefix?: string | undefined;
	tunnel_id?: number | undefined;
	cf_zone_id?: number | undefined;
}

/** Which protocols each tunnel provider can actually carry. */
const SUPPORTED_PROTOCOLS: Record<string, string[]> = {
	cloudflared: ['http', 'https'],
	playit: ['tcp', 'udp'],
};

/**
 * Returns `null` when the placement is allowed, or the problem to report.
 *
 * Only `cloudflare_tunnel` hosts have placement rules — a `local_nginx` host
 * has no tunnel and no DNS record to get wrong.
 */
export async function checkHostPlacement(
	input: PlacementInput,
	userId: number
): Promise<PlacementProblem | null> {
	if (input.mode !== 'cloudflare_tunnel') return null;

	if (!input.tunnel_id) {
		return { error: 'cloudflare_tunnel mode requires tunnel_id', code: 'BAD_REQUEST' };
	}

	const knex = getDb();

	// Ownership runs through whichever account table the provider uses.
	const tunnel = await knex<{ id: number; provider: string }>('tunnels')
		.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
		.leftJoin('playit_accounts', 'playit_accounts.id', 'tunnels.playit_account_id')
		.where('tunnels.id', input.tunnel_id)
		.andWhere((b) => {
			b.where('cloudflare_accounts.user_id', userId).orWhere('playit_accounts.user_id', userId);
		})
		.select('tunnels.id', 'tunnels.provider')
		.first();
	if (!tunnel) {
		return { error: 'Tunnel not found or not yours', code: 'BAD_REQUEST' };
	}

	const protocol = input.protocol ?? 'http';
	const providerName = tunnel.provider ?? 'cloudflared';

	if (!SUPPORTED_PROTOCOLS[providerName]?.includes(protocol)) {
		return {
			error: `Tunnel uses provider '${providerName}' which does not support protocol '${protocol}'.`,
			code: 'PROTOCOL_PROVIDER_MISMATCH',
		};
	}

	// path_prefix is only meaningful for HTTP routing.
	if (protocol !== 'http' && protocol !== 'https' && input.path_prefix && input.path_prefix !== '/') {
		return {
			error: `path_prefix is only valid for http/https protocols (got '${protocol}').`,
			code: 'PATH_PREFIX_NOT_ALLOWED',
		};
	}

	// Zone is required for cloudflared (CNAME) and Java MC over TCP (SRV
	// record), but optional for Bedrock UDP, which publishes no DNS record.
	const needsZone = providerName === 'cloudflared' || (providerName === 'playit' && protocol === 'tcp');
	if (needsZone && !input.cf_zone_id) {
		return {
			error: `Protocol '${protocol}' on provider '${providerName}' requires a cf_zone_id for the DNS record.`,
			code: 'ZONE_REQUIRED',
		};
	}

	if (input.cf_zone_id) {
		const zone = await knex<{ name: string }>('cf_zones').where({ id: input.cf_zone_id }).first();
		if (!zone) {
			return { error: 'Zone not found', code: 'BAD_REQUEST' };
		}
		if (!input.hostname.endsWith(zone.name)) {
			return {
				error: `Hostname must end with the chosen zone (${zone.name})`,
				code: 'HOSTNAME_ZONE_MISMATCH',
			};
		}
	}

	return null;
}
