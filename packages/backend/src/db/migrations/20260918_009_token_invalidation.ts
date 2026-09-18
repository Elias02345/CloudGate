import type { Knex } from 'knex';

/**
 * Adds `users.tokens_valid_after` so a password change can revoke sessions.
 *
 * JWTs are stateless: until now, changing a password left every previously
 * issued token valid for the rest of its 8h TTL. Someone who changed their
 * password *because* they suspected a stolen token stayed compromised.
 *
 * This column is the revocation line. `requireAuth` rejects any token whose
 * `iat` predates it, which costs nothing extra at request time — the user row
 * is already loaded there.
 *
 * NULL means "never revoked", so existing installations keep working and
 * existing sessions survive the update. Per CLAUDE.md §3: nullable, additive,
 * idempotent via hasColumn.
 */

export async function up(knex: Knex): Promise<void> {
	const hasColumn = await knex.schema.hasColumn('users', 'tokens_valid_after');
	if (hasColumn) return;

	await knex.schema.alterTable('users', (t) => {
		t.string('tokens_valid_after').nullable();
	});
}

export async function down(knex: Knex): Promise<void> {
	const hasColumn = await knex.schema.hasColumn('users', 'tokens_valid_after');
	if (!hasColumn) return;

	await knex.schema.alterTable('users', (t) => {
		t.dropColumn('tokens_valid_after');
	});
}
