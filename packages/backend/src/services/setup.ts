/**
 * First-run admin creation — the actual DB write behind POST /api/setup.
 *
 * Two layers keep concurrent submissions from creating two admins:
 *  1. An in-process mutex (`mutex`) serialises the critical section within
 *     this Node process — the only process that ever handles this route.
 *     Each caller still runs its OWN check-and-insert once it's their turn;
 *     it never adopts another caller's result, which matters because two
 *     concurrent submissions can carry different credentials — one must not
 *     silently hand its session to the other.
 *  2. A knex transaction that re-checks `COUNT(users)` immediately before
 *     the insert, so the loser of the race — whichever request that turns
 *     out to be — reliably sees the winner's row and reports SETUP_DONE.
 */

import { getDb } from '../db/db.js';
import type { DbUser } from './auth.js';
import { hashPassword } from './auth.js';

export class SetupError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'SetupError';
		this.code = code;
	}
}

export interface CreateInitialAdminInput {
	email: string;
	name: string;
	password: string;
}

let mutex: Promise<void> = Promise.resolve();

export async function createInitialAdmin(input: CreateInitialAdminInput): Promise<DbUser> {
	const previous = mutex;
	let release: () => void = () => {};
	mutex = new Promise<void>((resolve) => {
		release = resolve;
	});
	// Wait for whoever's ahead of us to finish — ignore their outcome, we
	// only need the DB state they left behind.
	await previous;

	try {
		const knex = getDb();
		return await knex.transaction(async (trx) => {
			const existing = await trx('users').count<{ c: number }[]>({ c: '*' }).first();
			if (existing && Number(existing.c) > 0) {
				throw new SetupError('SETUP_DONE', 'An admin account already exists.');
			}
			const passwordHash = await hashPassword(input.password);
			const now = new Date().toISOString();
			const [id] = await trx('users').insert({
				email: input.email.toLowerCase(),
				password_hash: passwordHash,
				name: input.name,
				is_admin: true,
				must_change_password: false,
				created_at: now,
				updated_at: now,
			});
			const row = await trx<DbUser>('users').where({ id }).first();
			if (!row) throw new Error('Failed to read back newly created admin user');
			return row;
		});
	} finally {
		release();
	}
}
