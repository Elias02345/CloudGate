import type { Knex } from 'knex';

/**
 * Recover proxy_hosts rows whose `tunnel_id` got NULLed out by
 * migration 004's SQLite table rebuild.
 *
 * Why this happens: migration 004 calls `.alter()` four times on the
 * `tunnels` table to relax NOT NULL constraints. SQLite has no native
 * ALTER COLUMN, so Knex performs a table rebuild — CREATE temp →
 * INSERT … SELECT → DROP original → RENAME temp. Knex sets
 * `PRAGMA foreign_keys=OFF` around the rebuild, but in some
 * better-sqlite3 + connection-pool configurations the PRAGMA doesn't
 * stick to the connection doing the rebuild. When that happens the
 * `DROP TABLE tunnels` fires the `proxy_hosts.tunnel_id ON DELETE
 * SET NULL` cascade, orphaning every host attached to a CF tunnel.
 *
 * Symptom downstream: the host renders as "mode=cloudflare_tunnel but
 * tunnel_id=NULL", drops out of buildContext entirely, and the browser
 * sees cloudflared's http_status:404 catch-all.
 *
 * Recovery strategy:
 *   - If exactly ONE cloudflared tunnel exists, attach every orphan to
 *     it (the overwhelmingly common single-tunnel case).
 *   - If 0 cloudflared tunnels exist, mark each orphan with a
 *     last_error pointing at the Reassign UI; the user has to make a
 *     tunnel first.
 *   - If multiple cloudflared tunnels exist, we can't guess. Mark each
 *     orphan with a last_error explaining the situation and pointing
 *     at the new Reassign UI in the host's edit modal.
 *
 * Idempotent — re-running once orphans are fixed is a no-op.
 */

interface CfTunnel {
	id: number;
	name: string;
}

interface OrphanHost {
	id: number;
	hostname: string;
}

export async function up(knex: Knex): Promise<void> {
	const hasProvider = await knex.schema.hasColumn('tunnels', 'provider');
	if (!hasProvider) return; // 004 hasn't run yet — nothing to recover

	const cfTunnels = await knex<CfTunnel>('tunnels').where('provider', 'cloudflared').select('id', 'name');
	const orphans = await knex<OrphanHost>('proxy_hosts')
		.where('mode', 'cloudflare_tunnel')
		.whereNull('tunnel_id')
		.select('id', 'hostname');

	if (orphans.length === 0) return;

	if (cfTunnels.length === 1) {
		const tunnel = cfTunnels[0];
		if (!tunnel) return;
		await knex('proxy_hosts')
			.where('mode', 'cloudflare_tunnel')
			.whereNull('tunnel_id')
			.update({ tunnel_id: tunnel.id, last_error: null });
		// biome-ignore lint/suspicious/noConsole: migration boot-time diagnostic
		console.warn(
			`[migration 008] auto-recovered ${orphans.length} orphaned host(s) onto tunnel "${tunnel.name}" (id=${tunnel.id}): ${orphans.map((h) => h.hostname).join(', ')}`
		);
		return;
	}

	// Either zero or multiple tunnels — can't auto-fix. Mark with a
	// clear last_error so the UI surfaces the situation immediately.
	const reason =
		cfTunnels.length === 0
			? `Tunnel link was lost during a previous upgrade and no Cloudflare tunnel exists to re-attach to. Create a tunnel, then use "Edit host" → "Reassign tunnel".`
			: `Tunnel link was lost during a previous upgrade. Use "Edit host" → "Reassign tunnel" to attach this host to one of the ${cfTunnels.length} available tunnels.`;
	await knex('proxy_hosts')
		.where('mode', 'cloudflare_tunnel')
		.whereNull('tunnel_id')
		.update({ last_error: `⚠ ${reason}` });
	// biome-ignore lint/suspicious/noConsole: migration boot-time diagnostic
	console.warn(
		`[migration 008] flagged ${orphans.length} orphaned host(s) for manual re-link — ${cfTunnels.length} CF tunnel(s) exist, cannot auto-pick`
	);
}

export async function down(_knex: Knex): Promise<void> {
	// No-op: reverting would re-NULL hosts that are now correctly attached.
}
