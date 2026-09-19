/**
 * Taking a tunnel down properly, from anywhere.
 *
 * Deleting a tunnel is not one statement. The daemon has to be stopped, the
 * tunnel has to be deleted on the provider's side, and only then does the row
 * go. That sequence used to live inline in `DELETE /tunnels/:id`, which meant
 * it ran only when the user deleted a tunnel *by name*.
 *
 * Deleting a Cloudflare account did not go through it. `tunnels
 * .cloudflare_account_id` is declared `ON DELETE CASCADE` and SQLite has
 * foreign keys enabled, so the rows simply vanished underneath the
 * application: the cloudflared process kept running with no row to stop it
 * from, the tunnel stayed alive at Cloudflare, and every host on it was left
 * with `tunnel_id = NULL`. Playit is the same story by a different route —
 * `playit_account_id` carries no foreign key at all, so its tunnels were left
 * pointing at an account that no longer exists.
 *
 * So the sequence lives here, and both delete paths call it.
 *
 * Note on credentials: `/data/cloudflared/<uuid>.json` is deliberately left on
 * disk. It is a sacred path (see CLAUDE.md §1), and removing it is a separate
 * decision from deleting a row — this function only preserves what
 * `DELETE /tunnels/:id` already did.
 */

import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { decryptCredentials, getAccountById } from './cf-account.js';
import { clientFor } from './cloudflare-client.js';
import { stopTunnel } from './tunnel-manager.js';

const log = childLogger('tunnel-teardown');

/** The columns teardown actually needs. */
export interface TeardownTunnel {
	id: number;
	provider: string | null;
	tunnel_id: string;
	cloudflare_account_id: number | null;
	account_tag: string | null;
}

/**
 * Stop the daemon, clean up on the provider's side, then delete the row.
 *
 * Every step after the stop is best-effort and logged: a tunnel the user asked
 * to delete must end up deleted locally even if Cloudflare is unreachable,
 * otherwise a network blip leaves a row nobody can get rid of.
 */
export async function destroyTunnel(row: TeardownTunnel, userId: number): Promise<void> {
	try {
		await stopTunnel(row.id);
	} catch (err) {
		log.warn({ err: (err as Error).message, tunnel: row.id }, 'tunnel stop failed (continuing)');
	}

	if (row.provider === 'cloudflared' && row.cloudflare_account_id) {
		const account = await getAccountById(row.cloudflare_account_id, userId);
		if (account) {
			try {
				const creds = decryptCredentials(account);
				if (creds.type === 'api_token' && row.account_tag) {
					const cf = clientFor(creds.token);
					// biome-ignore lint/suspicious/noExplicitAny: SDK types
					await (cf.zeroTrust.tunnels.cloudflared as any).delete(row.tunnel_id, {
						account_id: row.account_tag,
					});
				}
			} catch (err) {
				log.warn(
					{ err: (err as Error).message, tunnel_id: row.tunnel_id },
					'CF tunnel delete failed (continuing)'
				);
			}
		}
	}
	// Playit: no upstream delete needed — the agent itself is shared, and
	// per-host port mappings get deleted via undeployHost when the user
	// removes their hosts.

	await getDb()('tunnels').where({ id: row.id }).delete();
	log.info({ tunnel: row.id, provider: row.provider }, 'Tunnel destroyed');
}

/**
 * Tear down every tunnel belonging to a provider account.
 *
 * Call this *before* deleting the account row. For Cloudflare the cascade
 * would otherwise do it silently; for Playit nothing would do it at all.
 */
export async function destroyTunnelsForAccount(
	column: 'cloudflare_account_id' | 'playit_account_id',
	accountId: number,
	userId: number
): Promise<number> {
	const rows = await getDb()<TeardownTunnel>('tunnels')
		.where({ [column]: accountId })
		.select('id', 'provider', 'tunnel_id', 'cloudflare_account_id', 'account_tag');

	for (const row of rows) {
		await destroyTunnel(row, userId);
	}
	if (rows.length > 0) {
		log.info({ account: accountId, column, count: rows.length }, 'Tore down account tunnels');
	}
	return rows.length;
}
