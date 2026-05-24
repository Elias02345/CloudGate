/**
 * Admin diagnostics + maintenance.
 *
 *   GET /api/admin/diagnostics
 *     Dumps DB integrity, migration status, tunnel/host counts, null-column
 *     survey on critical tables, and /data path presence. Admin-only.
 *     UI's "Download diagnostics" button uses this to produce a JSON blob
 *     the user can paste into a bug report.
 *
 * Never includes secrets, tokens, or passphrases in the output.
 */

import { existsSync, statSync } from 'node:fs';
import { Router, type Router as RouterType } from 'express';
import { VERSION, dataPath } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { requireAdmin, requireAuth, requirePasswordSet } from '../middleware/auth.js';

const log = childLogger('routes:admin');
export const adminRouter: RouterType = Router();

interface TableSurvey {
	table: string;
	row_count: number;
	null_columns?: Record<string, number>;
	error?: string;
}

interface MigrationRow {
	name: string;
	batch: number;
	migration_time: string;
}

adminRouter.get('/diagnostics', requireAuth, requirePasswordSet, requireAdmin, async (_req, res) => {
	const knex = getDb();
	const now = new Date().toISOString();

	// SQLite integrity check (cheap on small DBs)
	let integrity: string | { error: string } = 'unknown';
	try {
		const result = await knex.raw<Array<{ integrity_check?: string } | unknown>>('PRAGMA integrity_check');
		// better-sqlite3 returns rows directly; pg returns { rows: [...] }. Normalise.
		const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
		const first = rows[0] as Record<string, string> | undefined;
		integrity = first?.integrity_check ?? JSON.stringify(rows);
	} catch (err) {
		integrity = { error: (err as Error).message };
	}

	// Applied migrations — knex stores them in knex_migrations
	let migrations: MigrationRow[] | { error: string } = [];
	try {
		migrations = await knex<MigrationRow>('knex_migrations')
			.select('name', 'batch', 'migration_time')
			.orderBy('id');
	} catch (err) {
		migrations = { error: (err as Error).message };
	}

	// Per-table surveys — row counts + null-column hot spots that have
	// historically tripped people up after upgrades.
	const tables: TableSurvey[] = [];
	const criticalNullChecks: Record<string, string[]> = {
		tunnels: ['provider', 'tunnel_id', 'name', 'encrypted_tunnel_secret', 'account_tag', 'credentials_path'],
		proxy_hosts: ['protocol', 'hostname', 'forward_host', 'forward_port', 'mode'],
		cloudflare_accounts: ['encrypted_credentials', 'account_tag'],
		playit_accounts: ['encrypted_secret_key'],
	};
	for (const [table, cols] of Object.entries(criticalNullChecks)) {
		const survey: TableSurvey = { table, row_count: 0 };
		try {
			if (!(await knex.schema.hasTable(table))) {
				survey.error = 'table does not exist';
				tables.push(survey);
				continue;
			}
			const countRow = await knex(table).count<{ c: number }[]>({ c: '*' }).first();
			survey.row_count = Number(countRow?.c ?? 0);
			const nullColumns: Record<string, number> = {};
			for (const col of cols) {
				if (!(await knex.schema.hasColumn(table, col))) continue;
				const nullRow = await knex(table).whereNull(col).count<{ c: number }[]>({ c: '*' }).first();
				const n = Number(nullRow?.c ?? 0);
				if (n > 0) nullColumns[col] = n;
			}
			if (Object.keys(nullColumns).length > 0) survey.null_columns = nullColumns;
		} catch (err) {
			survey.error = (err as Error).message;
		}
		tables.push(survey);
	}

	// Tunnel summary (no secrets!)
	let tunnels: Array<{
		id: number;
		name: string;
		provider: string;
		status: string;
		has_meta_error: boolean;
	}> = [];
	try {
		const rows = await knex<{
			id: number;
			name: string;
			provider: string | null;
			status: string;
			provider_meta: string | null;
		}>('tunnels').select('id', 'name', 'provider', 'status', 'provider_meta');
		tunnels = rows.map((r) => {
			let hasMetaError = false;
			try {
				const meta = JSON.parse(r.provider_meta || '{}');
				hasMetaError = Boolean(meta.last_error);
			} catch {
				hasMetaError = false;
			}
			return {
				id: r.id,
				name: r.name,
				provider: r.provider ?? 'cloudflared',
				status: r.status,
				has_meta_error: hasMetaError,
			};
		});
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'diagnostics: tunnel summary failed');
	}

	// /data path inventory — covers the "did the volume mount survive update"
	// failure mode without revealing file contents.
	const dataPaths: Record<string, { exists: boolean; is_dir?: boolean; size_bytes?: number }> = {};
	const checkPaths = [
		['secrets', 'encryption.key'],
		['secrets', 'jwt.key'],
		['db', 'db.sqlite'],
		['cloudflared', 'config.yml'],
		['cloudflared', 'bin'],
		['playit', 'bin'],
		['nginx', 'hosts'],
		['nginx', 'certs'],
		['.bootstrap-complete'],
	];
	for (const parts of checkPaths) {
		const p = dataPath(...parts);
		try {
			const st = statSync(p);
			dataPaths[parts.join('/')] = {
				exists: true,
				is_dir: st.isDirectory(),
				size_bytes: st.isFile() ? st.size : undefined,
			};
		} catch {
			dataPaths[parts.join('/')] = { exists: false };
		}
	}

	res.json({
		version: VERSION,
		generated_at: now,
		integrity_check: integrity,
		migrations,
		tables,
		tunnels,
		data_paths: dataPaths,
		bootstrap_complete: existsSync(dataPath('.bootstrap-complete')),
	});
});
