/**
 * Orchestrates cloudflared daemons across all `tunnels` rows.
 *
 * For M1 we have a single managed daemon per tunnel record (typically just
 * one). Multi-tunnel support follows the same pattern — each DB row gets
 * its own CloudflaredProcess instance keyed by tunnel.id.
 *
 * Public surface:
 *   - init() — call once at backend boot
 *   - startTunnel(tunnelId) / stopTunnel(tunnelId)
 *   - reloadTunnel(tunnelId) — re-renders config + SIGHUP
 *   - statusOf(tunnelId)
 *   - logsOf(tunnelId)
 */

import { writeFile } from 'node:fs/promises';
import { dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { CloudflaredProcess } from './cloudflared-process.js';
import { decryptCredentials } from './cf-account.js';
import { decryptJson } from './crypto.js';
import { buildContext, writeConfig } from './tunnel-config-writer.js';

const log = childLogger('tunnel-manager');

interface TunnelRow {
	id: number;
	cloudflare_account_id: number;
	tunnel_id: string;
	name: string;
	account_tag: string;
	encrypted_tunnel_secret: Buffer | string;
	credentials_path: string;
	status: string;
}

interface CredentialsJson {
	AccountTag: string;
	TunnelID: string;
	TunnelName: string;
	TunnelSecret: string;
}

const processes = new Map<number, CloudflaredProcess>();

async function ensureCredentialsFile(row: TunnelRow): Promise<string> {
	const raw =
		typeof row.encrypted_tunnel_secret === 'string'
			? row.encrypted_tunnel_secret
			: row.encrypted_tunnel_secret.toString('utf8');
	const secret = decryptJson<{ type: 'tunnel'; secret: string }>(raw);
	const payload: CredentialsJson = {
		AccountTag: row.account_tag,
		TunnelID: row.tunnel_id,
		TunnelName: row.name,
		TunnelSecret: secret.secret,
	};
	const outPath = dataPath('cloudflared', `${row.tunnel_id}.json`);
	await writeFile(outPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
	return outPath;
}

async function setStatus(tunnelDbId: number, status: string, err?: string): Promise<void> {
	const knex = getDb();
	await knex('tunnels')
		.where({ id: tunnelDbId })
		.update({
			status,
			last_status_at: new Date().toISOString(),
		});
	if (err) log.warn({ tunnelDbId, status, err }, 'Tunnel status changed');
	else log.info({ tunnelDbId, status }, 'Tunnel status changed');
}

/**
 * Render config + (re)start the daemon for the given tunnel DB row.
 */
export async function startTunnel(tunnelDbId: number): Promise<void> {
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
	if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);

	const credsPath = await ensureCredentialsFile(row);
	const updatedRow = { ...row, credentials_path: credsPath };
	if (row.credentials_path !== credsPath) {
		await knex('tunnels').where({ id: row.id }).update({ credentials_path: credsPath });
	}

	const ctx = await buildContext(updatedRow);
	await writeConfig(ctx);

	let proc = processes.get(tunnelDbId);
	if (!proc) {
		proc = new CloudflaredProcess({
			tunnelId: row.tunnel_id,
			configPath: dataPath('cloudflared', 'config.yml'),
			onStatusChange: (s, err) => void setStatus(tunnelDbId, s, err),
		});
		processes.set(tunnelDbId, proc);
	}
	proc.start();
}

export async function stopTunnel(tunnelDbId: number): Promise<void> {
	const proc = processes.get(tunnelDbId);
	if (!proc) return;
	await proc.stop();
}

/**
 * After a host change: re-render config + SIGHUP the running daemon.
 * If daemon isn't running yet, just renders the file.
 */
export async function reloadTunnel(tunnelDbId: number): Promise<void> {
	const knex = getDb();
	const row = await knex<TunnelRow>('tunnels').where({ id: tunnelDbId }).first();
	if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);
	const ctx = await buildContext(row);
	await writeConfig(ctx);

	const proc = processes.get(tunnelDbId);
	if (proc) proc.reload();
}

export function statusOf(tunnelDbId: number): string {
	const proc = processes.get(tunnelDbId);
	if (!proc) return 'stopped';
	return proc.currentStatus;
}

export function logsOf(tunnelDbId: number, maxLines = 200): string[] {
	const proc = processes.get(tunnelDbId);
	if (!proc) return [];
	return proc.getLogs(maxLines);
}

/**
 * Backend boot: revive any tunnel that was marked running before shutdown.
 */
export async function init(): Promise<void> {
	const knex = getDb();
	const rows = await knex<TunnelRow>('tunnels').select('*');
	for (const row of rows) {
		try {
			await startTunnel(row.id);
			log.info({ tunnel: row.name }, 'Revived tunnel on boot');
		} catch (err) {
			log.error({ err: (err as Error).message, tunnel: row.name }, 'Failed to revive tunnel on boot');
			await setStatus(row.id, 'error', (err as Error).message);
		}
	}
}

// Use decryptCredentials so the import isn't tree-shaken (used later in
// post-tunnel-create flow for account verification). Touch to keep linter happy.
void decryptCredentials;
