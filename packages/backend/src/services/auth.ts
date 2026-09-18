/**
 * Authentication service.
 *
 * Responsibilities:
 *  - Verify user credentials (email + password) against argon2 hashes.
 *  - Issue + verify JWTs signed with /data/secrets/jwt.key (HS256).
 *  - Hash + rehash passwords.
 *
 * The user table & seed admin are owned by bootstrap.ts; this service
 * just reads/writes existing rows.
 */

import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { type JWTPayload, SignJWT, jwtVerify } from 'jose';
import { dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';

const log = childLogger('auth');

const ACCESS_TOKEN_TTL = '8h';
const ISSUER = 'cloudgate';
const AUDIENCE = 'cloudgate-api';

let cachedJwtKey: Uint8Array | null = null;

function loadJwtKey(): Uint8Array {
	if (cachedJwtKey) return cachedJwtKey;
	const raw = readFileSync(dataPath('secrets', 'jwt.key'), 'utf8').trim();
	const key = Buffer.from(raw, 'base64');
	if (key.length < 32) {
		throw new Error(`Invalid JWT key length: expected >=32 bytes, got ${key.length}`);
	}
	cachedJwtKey = new Uint8Array(key);
	return cachedJwtKey;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(plaintext: string): Promise<string> {
	return argon2.hash(plaintext, {
		type: argon2.argon2id,
		memoryCost: 2 ** 16,
		timeCost: 3,
		parallelism: 1,
	});
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, plaintext);
	} catch (err) {
		log.warn({ err }, 'Argon2 verify threw — treating as failed login');
		return false;
	}
}

// ---------------------------------------------------------------------------
// JWT issue + verify
// ---------------------------------------------------------------------------

export interface JwtClaims extends JWTPayload {
	sub: string; // user id (stringified)
	email: string;
	is_admin: boolean;
}

export async function issueAccessToken(
	claims: Omit<JwtClaims, 'iat' | 'exp' | 'iss' | 'aud'>
): Promise<string> {
	const key = loadJwtKey();
	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setExpirationTime(ACCESS_TOKEN_TTL)
		.sign(key);
}

/**
 * Short-lived ticket for the SSE stream.
 *
 * `EventSource` cannot set headers, so its credential has to travel in the URL
 * — and a URL is the one place a credential must not be: nginx writes the full
 * request line to its access log on every page load, and so does any tunnel or
 * edge in front of it. Handing the 8-hour session token to that stream meant
 * anyone who could read a log line had a session.
 *
 * This ticket is minted on demand, lives a minute, and carries its own
 * audience so it is refused everywhere except the event stream. Leaking one
 * costs a minute of read-only event traffic instead of a day's access.
 */
const SSE_TICKET_TTL = '60s';
const SSE_AUDIENCE = 'cloudgate-sse';

export async function issueSseTicket(userId: number): Promise<string> {
	const key = loadJwtKey();
	return new SignJWT({ sub: String(userId) })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setIssuer(ISSUER)
		.setAudience(SSE_AUDIENCE)
		.setExpirationTime(SSE_TICKET_TTL)
		.sign(key);
}

export async function verifySseTicket(token: string): Promise<{ sub: string }> {
	const key = loadJwtKey();
	const { payload } = await jwtVerify(token, key, {
		issuer: ISSUER,
		audience: SSE_AUDIENCE,
	});
	if (typeof payload.sub !== 'string') throw new Error('SSE ticket has no subject');
	return { sub: payload.sub };
}

export async function verifyAccessToken(token: string): Promise<JwtClaims> {
	const key = loadJwtKey();
	const { payload } = await jwtVerify(token, key, {
		issuer: ISSUER,
		audience: AUDIENCE,
	});
	return payload as JwtClaims;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export interface DbUser {
	id: number;
	email: string;
	password_hash: string;
	name: string;
	is_admin: number; // sqlite stores bool as 0/1
	totp_secret: string | null;
	totp_enabled: number;
	must_change_password: number;
	last_login_at: string | null;
	/** Tokens issued before this instant are rejected. NULL = never revoked. */
	tokens_valid_after: string | null;
	/** Last TOTP step consumed, so a code cannot be used twice. NULL = none. */
	totp_last_step: number | null;
	created_at: string;
	updated_at: string;
}

/**
 * Has this token been revoked by a later password change?
 *
 * JWT `iat` has one-second resolution, so a token minted in the same second
 * as the revocation survives. Closing that window would mean rejecting the
 * fresh token handed out by the password-change request itself, which is the
 * worse trade: it would log the user out of the session they are actively using.
 */
export function isTokenRevoked(claims: JwtClaims, user: DbUser): boolean {
	if (!user.tokens_valid_after) return false;
	const revokedAt = Date.parse(user.tokens_valid_after);
	if (Number.isNaN(revokedAt)) return false;
	if (typeof claims.iat !== 'number') return true; // no issue time — cannot prove it is current
	return claims.iat < Math.floor(revokedAt / 1000);
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
	const knex = getDb();
	const row = await knex<DbUser>('users').where({ email: email.toLowerCase() }).first();
	return row ?? null;
}

export async function findUserById(id: number): Promise<DbUser | null> {
	const knex = getDb();
	const row = await knex<DbUser>('users').where({ id }).first();
	return row ?? null;
}

/** TOTP step number for a moment in time — otplib's default 30-second period. */
export function totpStepFor(atMs: number = Date.now()): number {
	return Math.floor(atMs / 30_000);
}

/**
 * Claim a TOTP step for a user, rejecting a code that was already used.
 *
 * otplib accepts a code for its whole 30-second step, any number of times.
 * RFC 6238 §5.2 says a verifier must accept each step only once: an observed
 * code should not stay usable for the rest of its window.
 *
 * The check and the write are one conditional UPDATE on purpose. Reading the
 * column and then writing it would let two requests carrying the same code
 * both pass before either wrote — which is precisely the replay this is meant
 * to stop. The row count tells us whether we won the claim.
 */
export async function claimTotpStep(userId: number, step: number): Promise<boolean> {
	const knex = getDb();
	const updated = await knex('users')
		.where({ id: userId })
		.where((b) => b.whereNull('totp_last_step').orWhere('totp_last_step', '<', step))
		.update({ totp_last_step: step });
	return updated > 0;
}

export async function recordLogin(userId: number): Promise<void> {
	const knex = getDb();
	await knex('users')
		.where({ id: userId })
		.update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

export async function changePassword(userId: number, newPlaintext: string): Promise<void> {
	const knex = getDb();
	const hash = await hashPassword(newPlaintext);
	const now = new Date().toISOString();
	await knex('users').where({ id: userId }).update({
		password_hash: hash,
		must_change_password: 0,
		// Revoke every token issued so far. Someone changing their password
		// after a suspected compromise expects exactly this; the caller hands
		// the user a fresh token so their current session survives.
		tokens_valid_after: now,
		updated_at: now,
	});
}

/**
 * Public summary of a user — what we send back in responses.
 * Strips the password hash and other secrets.
 */
export function publicUser(row: DbUser): {
	id: number;
	email: string;
	name: string;
	is_admin: boolean;
	totp_enabled: boolean;
	must_change_password: boolean;
	last_login_at: string | null;
	created_at: string;
	updated_at: string;
} {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		is_admin: Boolean(row.is_admin),
		totp_enabled: Boolean(row.totp_enabled),
		must_change_password: Boolean(row.must_change_password),
		last_login_at: row.last_login_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
