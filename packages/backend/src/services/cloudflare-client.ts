/**
 * Cloudflare API client.
 *
 * Wraps the official `cloudflare` npm package with CloudGate-specific
 * conveniences (token validation, structured error mapping, zone listing).
 *
 * Two auth modes:
 *   - 'api_token'  — User pastes a token from dash.cloudflare.com.
 *   - 'oauth'      — cert.pem from the cloudflared "login" flow (M4).
 *
 * For M1.2 only api_token is implemented.
 */

import Cloudflare from 'cloudflare';
import { childLogger } from '../logger.js';

const log = childLogger('cf-client');

export interface CloudflareTokenInfo {
	id: string;
	status: 'active' | 'disabled' | 'expired';
}

export interface CloudflareAccountSummary {
	id: string; // account_tag
	name: string;
}

export interface CloudflareZoneSummary {
	id: string; // zone_id
	name: string; // example.com
	status: string;
}

export class CloudflareApiError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'CloudflareApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * Build a Cloudflare client for a given API token.
 */
export function clientFor(token: string): Cloudflare {
	return new Cloudflare({ apiToken: token });
}

/**
 * Verify a token is valid + active.
 * Calls GET /user/tokens/verify.
 */
export async function verifyToken(token: string): Promise<CloudflareTokenInfo> {
	const cf = clientFor(token);
	try {
		const result = await cf.user.tokens.verify();
		if (!result || typeof result !== 'object' || !('id' in result)) {
			throw new CloudflareApiError(500, 'INVALID_RESPONSE', 'Cloudflare returned unexpected verify response');
		}
		return {
			id: String(result.id),
			status: (result.status as 'active' | 'disabled' | 'expired') ?? 'active',
		};
	} catch (err) {
		throw mapError(err, 'token verification');
	}
}

/**
 * List the accounts this token has access to.
 * Tokens are usually scoped to a single account, but the API can return multiple.
 */
export async function listAccounts(token: string): Promise<CloudflareAccountSummary[]> {
	const cf = clientFor(token);
	try {
		const accounts: CloudflareAccountSummary[] = [];
		for await (const acc of cf.accounts.list()) {
			accounts.push({ id: String(acc.id), name: String(acc.name) });
		}
		return accounts;
	} catch (err) {
		throw mapError(err, 'list accounts');
	}
}

/**
 * List zones visible to this token.
 */
export async function listZones(token: string): Promise<CloudflareZoneSummary[]> {
	const cf = clientFor(token);
	try {
		const zones: CloudflareZoneSummary[] = [];
		for await (const z of cf.zones.list()) {
			zones.push({
				id: String(z.id),
				name: String(z.name),
				status: String(z.status ?? 'unknown'),
			});
		}
		return zones;
	} catch (err) {
		throw mapError(err, 'list zones');
	}
}

/**
 * Convert SDK errors into a clean CloudflareApiError that routes can serialise.
 */
function mapError(err: unknown, what: string): CloudflareApiError {
	const e = err as { status?: number; statusCode?: number; message?: string; code?: string };
	const status = e.status ?? e.statusCode ?? 500;
	const code = e.code ?? (status === 401 || status === 403 ? 'CF_AUTH_FAILED' : 'CF_API_ERROR');
	const message = e.message ?? `Cloudflare API error during ${what}`;
	log.warn({ status, code, message, what }, 'Cloudflare API call failed');
	return new CloudflareApiError(status, code, message);
}
