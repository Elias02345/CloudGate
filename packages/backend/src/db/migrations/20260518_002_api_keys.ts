import type { Knex } from 'knex';

/**
 * Adds the api_keys table — long-lived tokens for shell/AI-agent access.
 *
 * Key format: `cgk_<8charPrefix>_<32charSecret>`
 *   - `prefix` (plain) is the lookup index
 *   - `key_hash` is sha256(full_key) — verified at request time
 *   - Full key is shown only once at creation
 *
 * Per CLAUDE.md §3: nullable / defaulted columns only, idempotent via
 * hasTable guard.
 */

export async function up(knex: Knex): Promise<void> {
	const exists = await knex.schema.hasTable('api_keys');
	if (exists) return;

	await knex.schema.createTable('api_keys', (t) => {
		t.increments('id').primary();
		t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
		t.string('name').notNullable();
		t.string('prefix').notNullable().unique(); // e.g. "cgk_a3f9b201"
		t.string('key_hash').notNullable(); // sha256(full key)
		t.string('scope').notNullable().defaultTo('admin'); // 'read' | 'admin'
		t.string('last_used_at').nullable();
		t.string('last_used_ip').nullable();
		t.string('expires_at').nullable();
		t.string('created_at').notNullable();
		t.index('prefix', 'api_keys_prefix_idx');
		t.index('user_id', 'api_keys_user_id_idx');
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTableIfExists('api_keys');
}
