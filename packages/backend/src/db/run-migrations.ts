/**
 * Standalone migration runner — bypasses the Knex CLI entirely.
 *
 * Used by `apply-update.sh` after the swap. Reasons we don't shell out
 * to `knex migrate:latest`:
 *   1. The CLI's `directory:` resolution is CWD-relative, knex's
 *      knexfile.js path is parsed against CWD too, so a single wrong
 *      cwd silently picks an empty migrations dir → "Already up to date"
 *      OR "no such file or directory" depending on knex version.
 *   2. The CLI binary is sometimes a symlink (tarball can mangle it)
 *      and sometimes a shell wrapper (won't execute under `node ...`).
 *   3. We get clearer error messages by running migrations inline and
 *      printing the actual Knex error.
 *
 * Invocation (from apply-update.sh after swap):
 *   cd /app/backend
 *   node dist/db/run-migrations.js
 *
 * Exit codes:
 *   0  — all migrations applied (or already up-to-date)
 *   1  — error; full stack trace printed to stderr
 *
 * This file is COMPILED — tsx development uses knex CLI directly via
 * package.json scripts.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';
import { dataPath } from '../config.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(THIS_DIR, 'migrations');

async function main(): Promise<void> {
	const dbPath = dataPath('db', 'db.sqlite');

	// Pre-flight: db file should exist (bootstrap creates it). If it
	// doesn't, that's a separate fatal — print a clear error and bail.
	const dbExists = existsSync(dbPath);
	console.log(`[run-migrations] db path:          ${dbPath} (exists: ${dbExists})`);
	console.log(`[run-migrations] migrations dir:   ${MIGRATIONS_DIR}`);
	console.log(`[run-migrations] migrations exist: ${existsSync(MIGRATIONS_DIR)}`);

	if (!existsSync(MIGRATIONS_DIR)) {
		throw new Error(
			`Migrations directory not found at ${MIGRATIONS_DIR}. ` +
				`The release tarball is incomplete — expected backend/dist/db/migrations/ to exist.`,
		);
	}

	const k = knexFactory({
		client: 'better-sqlite3',
		connection: { filename: dbPath },
		useNullAsDefault: true,
		migrations: {
			directory: MIGRATIONS_DIR,
			loadExtensions: ['.js'],
			disableTransactions: false,
		},
	});

	try {
		console.log('[run-migrations] checking pending migrations...');
		const [completed, pending] = await k.migrate.list();
		console.log(`[run-migrations] completed: ${completed.length} · pending: ${pending.length}`);
		if (pending.length === 0) {
			console.log('[run-migrations] no pending migrations — db is up-to-date');
			return;
		}
		for (const p of pending) {
			console.log(`[run-migrations]   → ${typeof p === 'string' ? p : p.file}`);
		}
		console.log('[run-migrations] running migrate:latest ...');
		const t0 = Date.now();
		const result = await k.migrate.latest();
		console.log(`[run-migrations] applied ${result[1].length} migration(s) in ${Date.now() - t0}ms`);
		for (const m of result[1]) {
			console.log(`[run-migrations]   ✓ ${m}`);
		}
	} finally {
		await k.destroy();
	}
}

main().then(
	() => {
		console.log('[run-migrations] done');
		process.exit(0);
	},
	(err: Error) => {
		console.error('[run-migrations] FAILED');
		console.error(err.stack ?? err.message);
		process.exit(1);
	},
);
