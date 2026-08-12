import type { Knex } from 'knex';

/**
 * Per-host advanced options — surfaces cloudflared originRequest knobs
 * that real-world apps need.
 *
 * The big one: HomeAssistant returns "400 Bad Request" when proxied
 * because HA checks `trusted_proxies` against `X-Forwarded-For`. Letting
 * the user pin `httpHostHeader: "homeassistant.local:8123"` lets HA see
 * a Host header it recognises.
 *
 * JSON blob (vs many columns) so we can add fields later without more
 * migrations. Shape mirrors cloudflared's originRequest documentation.
 *
 * Per CLAUDE.md §3: nullable / defaulted, idempotent.
 */

export async function up(knex: Knex): Promise<void> {
	if (await knex.schema.hasColumn('proxy_hosts', 'advanced_options')) {
		return;
	}
	await knex.schema.alterTable('proxy_hosts', (t) => {
		t.text('advanced_options').notNullable().defaultTo('{}');
	});
}

export async function down(knex: Knex): Promise<void> {
	if (await knex.schema.hasColumn('proxy_hosts', 'advanced_options')) {
		await knex.schema.alterTable('proxy_hosts', (t) => {
			t.dropColumn('advanced_options');
		});
	}
}
