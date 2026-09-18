import type { Knex } from 'knex';

/**
 * Adds `users.totp_last_step` so a TOTP code can only be used once.
 *
 * otplib is configured with the default `window: 0`, so a code is accepted
 * only during its own 30-second step — but any number of times within it.
 * RFC 6238 §5.2 is explicit that a verifier must reject a second use of the
 * same step, otherwise an observed code (shoulder-surfed, captured by a
 * proxy, replayed from a devtools network panel) stays a live credential for
 * the rest of that window.
 *
 * Stores the last step number accepted for the user. NULL means "none used
 * yet", so existing installations keep working and nobody is locked out by
 * the update. Per CLAUDE.md §3: nullable, additive, idempotent via hasColumn.
 */

export async function up(knex: Knex): Promise<void> {
	const hasColumn = await knex.schema.hasColumn('users', 'totp_last_step');
	if (hasColumn) return;

	await knex.schema.alterTable('users', (t) => {
		t.bigInteger('totp_last_step').nullable();
	});
}

export async function down(knex: Knex): Promise<void> {
	const hasColumn = await knex.schema.hasColumn('users', 'totp_last_step');
	if (!hasColumn) return;

	await knex.schema.alterTable('users', (t) => {
		t.dropColumn('totp_last_step');
	});
}
