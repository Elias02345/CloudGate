import type { Knex } from 'knex';

/**
 * Tunnel provider abstraction — adds support for non-Cloudflare tunnel
 * providers (Playit) so CloudGate can host TCP/UDP services such as Minecraft.
 *
 * Per CLAUDE.md §3 this migration is:
 *  - Purely additive (new columns nullable / defaulted; new table).
 *  - Making existing CF-specific tunnel columns nullable so Playit tunnels
 *    can co-exist in the same table without bogus values. Provider-specific
 *    state lives in the new `provider_meta` JSON column.
 *  - Idempotent via hasColumn / hasTable guards — safe to re-run.
 *  - down() reverses the additions but does NOT re-tighten NOT NULLs
 *    (would fail if Playit rows existed at the moment of rollback).
 */

export async function up(knex: Knex): Promise<void> {
	// -----------------------------------------------------------------------
	// tunnels: add `provider` + `provider_meta`
	// -----------------------------------------------------------------------
	if (!(await knex.schema.hasColumn('tunnels', 'provider'))) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.string('provider').notNullable().defaultTo('cloudflared');
		});
		// Be explicit about backfill — SQLite already applied defaultTo to
		// existing rows, but this is the contract we want documented.
		await knex('tunnels').whereNull('provider').update({ provider: 'cloudflared' });
	}

	if (!(await knex.schema.hasColumn('tunnels', 'provider_meta'))) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.text('provider_meta').notNullable().defaultTo('{}');
		});
	}

	// Top-level FK to playit_accounts so the user-ownership join is fast and
	// doesn't require parsing provider_meta JSON. Null for cloudflared tunnels.
	if (!(await knex.schema.hasColumn('tunnels', 'playit_account_id'))) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.integer('playit_account_id').nullable();
		});
	}

	// -----------------------------------------------------------------------
	// tunnels: relax CF-specific NOT NULL constraints
	//
	// Playit tunnels have no Cloudflare account, no tunnel_secret and no
	// credentials_path. We move provider-specific fields to provider_meta.
	// Knex 3.x performs a SQLite table rebuild under the hood for .alter().
	// -----------------------------------------------------------------------
	await knex.schema.alterTable('tunnels', (t) => {
		t.integer('cloudflare_account_id').nullable().alter();
		t.binary('encrypted_tunnel_secret').nullable().alter();
		t.string('credentials_path').nullable().alter();
		t.string('account_tag').nullable().alter();
	});

	// -----------------------------------------------------------------------
	// proxy_hosts: `protocol` + `edge_endpoint`
	// -----------------------------------------------------------------------
	if (!(await knex.schema.hasColumn('proxy_hosts', 'protocol'))) {
		await knex.schema.alterTable('proxy_hosts', (t) => {
			t.string('protocol').notNullable().defaultTo('http');
		});
		await knex('proxy_hosts').whereNull('protocol').update({ protocol: 'http' });
	}

	if (!(await knex.schema.hasColumn('proxy_hosts', 'edge_endpoint'))) {
		await knex.schema.alterTable('proxy_hosts', (t) => {
			// JSON snapshot of the last ProviderEdgeEndpoint returned by the
			// provider — debugging aid + lets the UI show the assigned
			// external host:port for Playit hosts.
			t.text('edge_endpoint').nullable();
		});
	}

	// -----------------------------------------------------------------------
	// playit_accounts (analog to cloudflare_accounts)
	// -----------------------------------------------------------------------
	if (!(await knex.schema.hasTable('playit_accounts'))) {
		await knex.schema.createTable('playit_accounts', (t) => {
			t.increments('id').primary();
			t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
			t.string('label').notNullable();
			// Stored as base64url-encoded ciphertext via services/crypto.ts.
			// Column is typed binary for parity with cloudflare_accounts.
			t.binary('encrypted_secret_key').notNullable();
			t.string('status').notNullable().defaultTo('active');
			t.string('last_validated_at').nullable();
			t.string('created_at').notNullable();
			t.index('user_id', 'playit_accounts_user_idx');
		});
	}
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTableIfExists('playit_accounts');

	if (await knex.schema.hasColumn('proxy_hosts', 'edge_endpoint')) {
		await knex.schema.alterTable('proxy_hosts', (t) => {
			t.dropColumn('edge_endpoint');
		});
	}
	if (await knex.schema.hasColumn('proxy_hosts', 'protocol')) {
		await knex.schema.alterTable('proxy_hosts', (t) => {
			t.dropColumn('protocol');
		});
	}

	if (await knex.schema.hasColumn('tunnels', 'playit_account_id')) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.dropColumn('playit_account_id');
		});
	}

	if (await knex.schema.hasColumn('tunnels', 'provider_meta')) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.dropColumn('provider_meta');
		});
	}
	if (await knex.schema.hasColumn('tunnels', 'provider')) {
		await knex.schema.alterTable('tunnels', (t) => {
			t.dropColumn('provider');
		});
	}

	// Intentionally NOT re-tightening NOT NULL on
	// cloudflare_account_id/encrypted_tunnel_secret/credentials_path/account_tag —
	// would crash on rollback if Playit rows had been inserted.
}
