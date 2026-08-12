import type { Knex } from 'knex';

/**
 * Backfill `proxy_hosts.protocol` for any row where migration 004's
 * default-value backfill didn't take. SQLite's ALTER TABLE … ADD COLUMN
 * is normally reliable about applying `defaultTo` to existing rows, but
 * `004` did a table-rebuild dance immediately afterwards (making CF
 * columns nullable) and we've seen installs where some rows ended up
 * with `protocol = NULL`.
 *
 * The damage shows up as "live and running but page not found" because
 * `buildContext` uses `whereIn('protocol', ['http','https'])` and NULL
 * doesn't match either — the affected host gets silently dropped from
 * cloudflared's ingress, so the daemon serves the `http_status:404`
 * catch-all for it.
 *
 * Idempotent — re-running is a no-op once protocols are filled.
 */

export async function up(knex: Knex): Promise<void> {
	if (!(await knex.schema.hasColumn('proxy_hosts', 'protocol'))) {
		// Migration 004 hasn't applied yet (out of order or fresh
		// install) — nothing to backfill.
		return;
	}
	const result = await knex('proxy_hosts').whereNull('protocol').update({ protocol: 'http' });
	if (result > 0) {
		// biome-ignore lint/suspicious/noConsole: migration boot-time diagnostic
		console.warn(`[migration 007] backfilled protocol='http' on ${result} proxy_hosts row(s)`);
	}
}

export async function down(_knex: Knex): Promise<void> {
	// No-op: undoing would put rows back into the broken state.
}
