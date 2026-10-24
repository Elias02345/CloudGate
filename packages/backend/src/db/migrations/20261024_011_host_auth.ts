import type { Knex } from 'knex';

/**
 * Per-host visitor authentication (issue #99).
 *
 * A host with a row here is served through the built-in auth gateway: the
 * visitor logs in with `username` + password (+ TOTP when enabled) before any
 * request reaches the origin. Hosts without a row are untouched.
 *
 * `totp_secret` is encrypted at rest (services/crypto). `updated_at` doubles
 * as the session epoch — changing the password or TOTP invalidates every
 * existing visitor session. Per CLAUDE.md §3: new table only, idempotent.
 */

export async function up(knex: Knex): Promise<void> {
	if (await knex.schema.hasTable('host_auth')) return;

	await knex.schema.createTable('host_auth', (t) => {
		t.increments('id').primary();
		t.integer('host_id').notNullable().unique().references('id').inTable('proxy_hosts').onDelete('CASCADE');
		t.string('username', 64).notNullable();
		t.text('password_hash').notNullable();
		t.text('totp_secret').nullable();
		t.integer('totp_enabled').notNullable().defaultTo(0);
		t.bigInteger('totp_last_step').nullable();
		t.string('created_at').notNullable();
		t.string('updated_at').notNullable();
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTableIfExists('host_auth');
}
