import type { Knex } from 'knex';

/**
 * Post-004 recovery & diagnostic pass.
 *
 * Migration 004 made several `tunnels` columns nullable via knex's SQLite
 * .alter() table-rebuild path. Some installs ended up with cloudflared
 * tunnel rows whose `encrypted_tunnel_secret` / `account_tag` /
 * `credentials_path` ended up NULL, which means the cloudflared provider
 * can't start them. The tunnel daemon dies before opening any ingress,
 * so users see "everything is broken after the update."
 *
 * This migration is purely diagnostic + flag-flipping:
 *  - Finds `provider='cloudflared'` rows with missing credentials.
 *  - Marks them `status='error'` and writes an actionable message into
 *    `provider_meta.last_error` so the UI shows a clear "Re-link" prompt
 *    instead of a generic spinner.
 *  - Logs a single-line summary at boot.
 *
 * No row data is mutated beyond status/provider_meta — the user's hosts
 * stay intact and can be reattached to a recreated tunnel via the new
 * `/api/tunnels/:id/recreate` endpoint.
 *
 * Idempotent — re-running is a no-op once the user has re-linked.
 */

interface TunnelRow {
	id: number;
	name: string;
	provider: string;
	encrypted_tunnel_secret: Buffer | string | null;
	account_tag: string | null;
	provider_meta: string | null;
	status: string;
}

export async function up(knex: Knex): Promise<void> {
	// Guard: schema bits we depend on must exist (added by migration 004).
	const ready =
		(await knex.schema.hasColumn('tunnels', 'provider')) &&
		(await knex.schema.hasColumn('tunnels', 'provider_meta'));
	if (!ready) {
		// Migration 004 hasn't applied (shouldn't happen — knex runs in order).
		// Bail silently — re-running 005 after 004 lands will pick it up.
		return;
	}

	const broken = await knex<TunnelRow>('tunnels')
		.where('provider', 'cloudflared')
		.andWhere((b) => {
			b.whereNull('encrypted_tunnel_secret').orWhereNull('account_tag').orWhere('account_tag', '');
		})
		.select('id', 'name', 'provider', 'encrypted_tunnel_secret', 'account_tag', 'provider_meta', 'status');

	if (broken.length === 0) {
		// Healthy install — nothing to do.
		return;
	}

	for (const row of broken) {
		let meta: Record<string, unknown> = {};
		try {
			meta = JSON.parse(row.provider_meta || '{}');
		} catch {
			meta = {};
		}
		const missing: string[] = [];
		if (!row.encrypted_tunnel_secret) missing.push('encrypted_tunnel_secret');
		if (!row.account_tag) missing.push('account_tag');
		meta.last_error = `Tunnel cannot start: missing ${missing.join(', ')} (lost during a previous upgrade). Use "Re-link" or "Recreate" to attach this tunnel to a Cloudflare account — your hosts will keep working.`;
		meta.last_error_at = new Date().toISOString();
		meta.recovery_needed = true;

		await knex('tunnels')
			.where({ id: row.id })
			.update({
				status: 'error',
				last_status_at: new Date().toISOString(),
				provider_meta: JSON.stringify(meta),
			});
	}

	// Log via console — the migration runner doesn't have access to the
	// pino logger (it's invoked before app boot in some paths).
	// biome-ignore lint/suspicious/noConsole: migration boot-time diagnostic
	console.warn(
		`[migration 005] flagged ${broken.length} cloudflared tunnel(s) needing re-link: ${broken.map((t) => `#${t.id} "${t.name}"`).join(', ')}`
	);
}

export async function down(_knex: Knex): Promise<void> {
	// No-op: this migration only flips status + writes a diagnostic message.
	// Reverting it would un-mark "needs relink" tunnels back to a falsely
	// healthy state, which is worse than the current state.
}
