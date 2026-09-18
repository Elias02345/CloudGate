/**
 * Tests for the password-change token revocation in services/auth.ts.
 *
 * `isTokenRevoked` is what stands between "I changed my password because I
 * think my token was stolen" and that token staying valid for another 8 hours,
 * so it gets its own check. Pure function — no DB, no /data needed beyond the
 * temp dir the config module wants at import time.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbUser, JwtClaims } from '../src/services/auth.js';
import { isTokenRevoked } from '../src/services/auth.js';

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-revoke-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal user row — only the field under test matters. */
function userWith(tokensValidAfter: string | null): DbUser {
	return {
		id: 1,
		email: 'admin@example.com',
		password_hash: 'x',
		name: 'Admin',
		is_admin: 1,
		totp_secret: null,
		totp_enabled: 0,
		must_change_password: 0,
		last_login_at: null,
		tokens_valid_after: tokensValidAfter,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	};
}

function claimsIssuedAt(date: Date): JwtClaims {
	return {
		sub: '1',
		email: 'admin@example.com',
		is_admin: true,
		iat: Math.floor(date.getTime() / 1000),
	};
}

describe('isTokenRevoked', () => {
	const changedAt = new Date('2026-09-18T12:00:00.000Z');

	it('accepts every token when the password was never changed', () => {
		const claims = claimsIssuedAt(new Date('2020-01-01T00:00:00.000Z'));
		expect(isTokenRevoked(claims, userWith(null))).toBe(false);
	});

	it('rejects a token issued before the password change', () => {
		const claims = claimsIssuedAt(new Date(changedAt.getTime() - 60_000));
		expect(isTokenRevoked(claims, userWith(changedAt.toISOString()))).toBe(true);
	});

	it('accepts a token issued after the password change', () => {
		const claims = claimsIssuedAt(new Date(changedAt.getTime() + 60_000));
		expect(isTokenRevoked(claims, userWith(changedAt.toISOString()))).toBe(false);
	});

	it('accepts the replacement token minted in the same second as the change', () => {
		// The password-change response hands back a fresh token; rejecting it
		// would log the user out of the session they are actively using.
		const claims = claimsIssuedAt(changedAt);
		expect(isTokenRevoked(claims, userWith(changedAt.toISOString()))).toBe(false);
	});

	it('rejects a token that carries no issue time at all', () => {
		const claims = { sub: '1', email: 'admin@example.com', is_admin: true } as JwtClaims;
		expect(isTokenRevoked(claims, userWith(changedAt.toISOString()))).toBe(true);
	});

	it('fails open on an unparseable timestamp rather than locking everyone out', () => {
		const claims = claimsIssuedAt(new Date('2020-01-01T00:00:00.000Z'));
		expect(isTokenRevoked(claims, userWith('not-a-date'))).toBe(false);
	});
});
