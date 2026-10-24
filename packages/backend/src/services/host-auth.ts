/**
 * Per-host visitor authentication (issue #99).
 *
 * Data + session logic only; the HTTP side lives in host-gateway.ts and the
 * admin API in routes/host-auth.ts.
 *
 * Sessions are stateless signed cookies (HS256, key derived from jwt.key with
 * a purpose label so they can't be replayed against the admin API). The
 * `ep` claim is the credential row's `updated_at`: changing the password or
 * TOTP setting ends every existing visitor session.
 */

import { type JWTPayload, SignJWT, jwtVerify } from 'jose';
import { authenticator } from 'otplib';
import { getDb } from '../db/db.js';
import { deriveSigningKey, getDummyHash, hashPassword, verifyPassword } from './auth.js';
import { decryptJson, encryptJson } from './crypto.js';

export const HOST_SESSION_COOKIE = 'cg_hostauth';
export const HOST_SESSION_TTL_SECONDS = 12 * 60 * 60;
const AUDIENCE = 'cloudgate-host-auth';
const KEY_LABEL = 'cloudgate/host-auth/session/v1';

export interface HostAuthRow {
	id: number;
	host_id: number;
	username: string;
	password_hash: string;
	totp_secret: string | null;
	totp_enabled: number;
	totp_last_step: number | null;
	created_at: string;
	updated_at: string;
}

export interface HostAuthSummary {
	enabled: true;
	username: string;
	totp_enabled: boolean;
}

export async function getHostAuth(hostId: number): Promise<HostAuthRow | null> {
	const row = await getDb()<HostAuthRow>('host_auth').where({ host_id: hostId }).first();
	return row ?? null;
}

export function summarise(row: HostAuthRow | null): HostAuthSummary | { enabled: false } {
	return row
		? { enabled: true, username: row.username, totp_enabled: Boolean(row.totp_enabled) }
		: { enabled: false };
}

export interface SaveHostAuthInput {
	username: string;
	/** Required when creating; omitted on update = keep the current password. */
	password?: string;
	/** Enable (secret + code) / disable (null) / leave alone (undefined). */
	totp?: { secret: string; code: string } | null;
}

export class HostAuthInputError extends Error {}

export async function saveHostAuth(hostId: number, input: SaveHostAuthInput): Promise<void> {
	const knex = getDb();
	const existing = await getHostAuth(hostId);
	if (!existing && !input.password) {
		throw new HostAuthInputError('A password is required to enable host authentication.');
	}
	const now = new Date().toISOString();
	const patch: Partial<HostAuthRow> = { username: input.username, updated_at: now };
	if (input.password) patch.password_hash = await hashPassword(input.password);

	if (input.totp === null) {
		patch.totp_secret = null;
		patch.totp_enabled = 0;
		patch.totp_last_step = null;
	} else if (input.totp) {
		if (!authenticator.verify({ token: input.totp.code, secret: input.totp.secret })) {
			throw new HostAuthInputError('The verification code is wrong. Scan the QR code again and retry.');
		}
		patch.totp_secret = encryptJson({ type: 'totp', secret: input.totp.secret });
		patch.totp_enabled = 1;
		// The setup code counts as used, so it can't be replayed at the login page.
		patch.totp_last_step = Math.floor(Date.now() / 30_000);
	}

	if (existing) {
		await knex('host_auth').where({ host_id: hostId }).update(patch);
	} else {
		await knex('host_auth').insert({
			host_id: hostId,
			username: input.username,
			password_hash: patch.password_hash as string,
			totp_secret: patch.totp_secret ?? null,
			totp_enabled: patch.totp_enabled ?? 0,
			totp_last_step: patch.totp_last_step ?? null,
			created_at: now,
			updated_at: now,
		});
	}
}

/**
 * Put a host's credentials back exactly as they were (null = none). Used when
 * the tunnel could not be redeployed after a change, so the stored state keeps
 * matching what cloudflared is actually doing.
 */
export async function restoreHostAuth(hostId: number, previous: HostAuthRow | null): Promise<void> {
	const knex = getDb();
	await knex.transaction(async (trx) => {
		await trx('host_auth').where({ host_id: hostId }).delete();
		if (previous) await trx('host_auth').insert(previous);
	});
}

export async function removeHostAuth(hostId: number): Promise<void> {
	await getDb()('host_auth').where({ host_id: hostId }).delete();
}

export type LoginResult = 'ok' | 'invalid' | 'totp_required' | 'totp_invalid';

export async function checkHostLogin(
	row: HostAuthRow,
	username: string,
	password: string,
	totpCode: string | undefined
): Promise<LoginResult> {
	const userMatches = username.trim().toLowerCase() === row.username.toLowerCase();
	const passwordOk = await verifyPassword(userMatches ? row.password_hash : await getDummyHash(), password);
	if (!userMatches || !passwordOk) return 'invalid';

	if (!row.totp_enabled) return 'ok';
	if (!totpCode) return 'totp_required';
	if (!row.totp_secret) return 'invalid'; // enabled without a secret: fail closed
	try {
		const { secret } = decryptJson<{ secret: string }>(row.totp_secret);
		if (!authenticator.verify({ token: totpCode.trim(), secret })) return 'totp_invalid';
	} catch {
		return 'invalid';
	}
	// Each 30 s step is accepted once (RFC 6238 §5.2). Conditional UPDATE so two
	// concurrent requests can't both win the same step.
	const step = Math.floor(Date.now() / 30_000);
	const claimed = await getDb()('host_auth')
		.where({ id: row.id })
		.where((b) => b.whereNull('totp_last_step').orWhere('totp_last_step', '<', step))
		.update({ totp_last_step: step });
	return claimed > 0 ? 'ok' : 'totp_invalid';
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

export async function issueHostSession(row: HostAuthRow): Promise<string> {
	return new SignJWT({ ep: row.updated_at })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(String(row.host_id))
		.setAudience(AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(`${HOST_SESSION_TTL_SECONDS}s`)
		.sign(deriveSigningKey(KEY_LABEL));
}

export async function verifyHostSession(token: string, row: HostAuthRow): Promise<boolean> {
	try {
		const { payload } = await jwtVerify(token, deriveSigningKey(KEY_LABEL), { audience: AUDIENCE });
		const p = payload as JWTPayload & { ep?: string };
		return p.sub === String(row.host_id) && p.ep === row.updated_at;
	} catch {
		return false;
	}
}
