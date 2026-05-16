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
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
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

export async function issueAccessToken(claims: Omit<JwtClaims, 'iat' | 'exp' | 'iss' | 'aud'>): Promise<string> {
	const key = loadJwtKey();
	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setExpirationTime(ACCESS_TOKEN_TTL)
		.sign(key);
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
	created_at: string;
	updated_at: string;
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

export async function recordLogin(userId: number): Promise<void> {
	const knex = getDb();
	await knex('users')
		.where({ id: userId })
		.update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

export async function changePassword(userId: number, newPlaintext: string): Promise<void> {
	const knex = getDb();
	const hash = await hashPassword(newPlaintext);
	await knex('users')
		.where({ id: userId })
		.update({
			password_hash: hash,
			must_change_password: 0,
			updated_at: new Date().toISOString(),
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
