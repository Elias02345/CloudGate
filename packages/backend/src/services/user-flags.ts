/**
 * Per-user UX flags (onboarding completion, app-tour state, etc.) persisted
 * in the existing `settings` key/value table under the `user.{id}.<name>`
 * namespace. No dedicated table needed — these are sparse, optional values.
 *
 * Per CLAUDE.md §4: new settings keys with defaults are added in code, not
 * via migration. Defaults are inlined here.
 */

import type { UserFlags } from '@cloudgate/shared';
import { getDb } from '../db/db.js';

const PREFIX = 'user.';

function flagKey(userId: number, name: string): string {
	return `${PREFIX}${userId}.${name}`;
}

const DEFAULT_FLAGS: UserFlags = {
	onboarding_completed_at: null,
	tour_completed_at: null,
	tour_dismissed: false,
};

const FLAG_NAMES: ReadonlyArray<keyof UserFlags> = [
	'onboarding_completed_at',
	'tour_completed_at',
	'tour_dismissed',
];

interface SettingsRow {
	key: string;
	value: string;
}

export async function getUserFlags(userId: number): Promise<UserFlags> {
	const knex = getDb();
	const keys = FLAG_NAMES.map((n) => flagKey(userId, n));
	const rows = await knex<SettingsRow>('settings').whereIn('key', keys);
	const result: UserFlags = { ...DEFAULT_FLAGS };
	for (const row of rows) {
		const name = row.key.slice(`${PREFIX}${userId}.`.length) as keyof UserFlags;
		if (!FLAG_NAMES.includes(name)) continue;
		try {
			const parsed = JSON.parse(row.value);
			// We trust our own writes; if JSON shape is off it falls back to default
			// via the spread above.
			(result as Record<string, unknown>)[name] = parsed;
		} catch {
			/* corrupt row — leave default */
		}
	}
	return result;
}

export async function setUserFlag<K extends keyof UserFlags>(
	userId: number,
	name: K,
	value: UserFlags[K]
): Promise<void> {
	const knex = getDb();
	await knex('settings')
		.insert({
			key: flagKey(userId, name),
			value: JSON.stringify(value),
			updated_at: new Date().toISOString(),
		})
		.onConflict('key')
		.merge();
}

/** Bulk-set: omit a key to leave it untouched. */
export async function patchUserFlags(userId: number, patch: Partial<UserFlags>): Promise<UserFlags> {
	for (const name of FLAG_NAMES) {
		if (Object.prototype.hasOwnProperty.call(patch, name)) {
			await setUserFlag(userId, name, patch[name] as UserFlags[typeof name]);
		}
	}
	return getUserFlags(userId);
}
