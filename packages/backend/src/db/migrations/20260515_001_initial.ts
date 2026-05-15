import type { Knex } from 'knex';

/**
 * Initial schema for CloudGate.
 *
 * This is the foundational migration. Per CLAUDE.md §3:
 * - All new columns must be NULLABLE or have defaults.
 * - Never edit this file in a future PR — add a new migration instead.
 * - All down() functions must be implemented and reversible.
 */

export async function up(knex: Knex): Promise<void> {
	// --- users -------------------------------------------------------------
	await knex.schema.createTable('users', (t) => {
		t.increments('id').primary();
		t.string('email').notNullable().unique();
		t.string('password_hash').notNullable();
		t.string('name').notNullable().defaultTo('User');
		t.boolean('is_admin').notNullable().defaultTo(false);
		t.string('totp_secret').nullable();
		t.boolean('totp_enabled').notNullable().defaultTo(false);
		t.boolean('must_change_password').notNullable().defaultTo(true);
		t.string('last_login_at').nullable();
		t.string('created_at').notNullable();
		t.string('updated_at').notNullable();
	});

	// --- settings ----------------------------------------------------------
	await knex.schema.createTable('settings', (t) => {
		t.string('key').primary();
		t.text('value').notNullable(); // JSON-encoded
		t.string('updated_at').notNullable();
	});

	// Seed default settings — keys can be added in future migrations.
	const now = new Date().toISOString();
	await knex('settings').insert([
		{ key: 'update_channel', value: JSON.stringify('stable'), updated_at: now },
		{ key: 'update_mode', value: JSON.stringify('notify'), updated_at: now },
		{ key: 'auto_update_minor_only', value: JSON.stringify(true), updated_at: now },
		{ key: 'cloudflared_auto_update', value: JSON.stringify('pinned'), updated_at: now },
		{ key: 'language', value: JSON.stringify('en'), updated_at: now },
	]);

	// --- cloudflare_accounts ----------------------------------------------
	await knex.schema.createTable('cloudflare_accounts', (t) => {
		t.increments('id').primary();
		t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
		t.string('label').notNullable();
		t.string('auth_type').notNullable(); // 'api_token' | 'oauth'
		t.binary('encrypted_credentials').notNullable();
		t.string('account_tag').notNullable();
		t.string('email').nullable();
		t.string('last_validated_at').nullable();
		t.string('created_at').notNullable();
	});

	// --- cf_zones ----------------------------------------------------------
	await knex.schema.createTable('cf_zones', (t) => {
		t.increments('id').primary();
		t.integer('cloudflare_account_id')
			.notNullable()
			.references('id')
			.inTable('cloudflare_accounts')
			.onDelete('CASCADE');
		t.string('zone_id').notNullable();
		t.string('name').notNullable();
		t.string('status').notNullable().defaultTo('active');
		t.string('last_synced_at').notNullable();
		t.unique(['cloudflare_account_id', 'zone_id']);
	});

	// --- tunnels -----------------------------------------------------------
	await knex.schema.createTable('tunnels', (t) => {
		t.increments('id').primary();
		t.integer('cloudflare_account_id')
			.notNullable()
			.references('id')
			.inTable('cloudflare_accounts')
			.onDelete('CASCADE');
		t.string('tunnel_id').notNullable().unique(); // CF UUID
		t.string('name').notNullable();
		t.string('account_tag').notNullable();
		t.binary('encrypted_tunnel_secret').notNullable();
		t.string('credentials_path').notNullable();
		t.string('status').notNullable().defaultTo('stopped');
		t.string('last_status_at').nullable();
		t.string('created_at').notNullable();
	});

	// --- proxy_hosts -------------------------------------------------------
	await knex.schema.createTable('proxy_hosts', (t) => {
		t.increments('id').primary();
		t.integer('tunnel_id').nullable().references('id').inTable('tunnels').onDelete('SET NULL');
		t.integer('cf_zone_id').nullable().references('id').inTable('cf_zones').onDelete('SET NULL');
		t.string('mode').notNullable(); // 'cloudflare_tunnel' | 'local_nginx'
		t.string('hostname').notNullable().unique();
		t.string('forward_scheme').notNullable().defaultTo('http');
		t.string('forward_host').notNullable();
		t.integer('forward_port').notNullable();
		t.string('path_prefix').notNullable().defaultTo('/');
		t.boolean('enabled').notNullable().defaultTo(true);
		t.string('dns_record_id').nullable();
		t.text('tls_options').notNullable().defaultTo('{}'); // JSON
		t.text('headers').notNullable().defaultTo('{}'); // JSON
		t.text('meta').notNullable().defaultTo('{}'); // JSON
		t.string('last_deployed_at').nullable();
		t.text('last_error').nullable();
		t.string('created_at').notNullable();
		t.string('updated_at').notNullable();
	});

	// --- audit_log ---------------------------------------------------------
	await knex.schema.createTable('audit_log', (t) => {
		t.increments('id').primary();
		t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
		t.string('action').notNullable();
		t.string('entity_type').nullable();
		t.integer('entity_id').nullable();
		t.text('meta').nullable(); // JSON
		t.string('ip').nullable();
		t.string('created_at').notNullable();
		t.index(['entity_type', 'entity_id']);
		t.index(['action']);
		t.index(['created_at']);
	});

	// --- update_history ----------------------------------------------------
	await knex.schema.createTable('update_history', (t) => {
		t.increments('id').primary();
		t.string('from_version').notNullable();
		t.string('to_version').notNullable();
		t.string('outcome').notNullable(); // 'succeeded' | 'failed' | 'rolled_back'
		t.text('steps_completed').notNullable().defaultTo('[]'); // JSON
		t.text('error_message').nullable();
		t.string('started_at').notNullable();
		t.string('finished_at').nullable();
		t.index(['started_at']);
	});
}

export async function down(knex: Knex): Promise<void> {
	// Reverse order — drop dependent tables first.
	await knex.schema.dropTableIfExists('update_history');
	await knex.schema.dropTableIfExists('audit_log');
	await knex.schema.dropTableIfExists('proxy_hosts');
	await knex.schema.dropTableIfExists('tunnels');
	await knex.schema.dropTableIfExists('cf_zones');
	await knex.schema.dropTableIfExists('cloudflare_accounts');
	await knex.schema.dropTableIfExists('settings');
	await knex.schema.dropTableIfExists('users');
}
