/**
 * Knex CLI configuration.
 *
 * Used by `knex migrate:make` during development and by apply-update.sh's
 * fallback migration path. The backend itself doesn't use this file —
 * it builds the config inline in db.ts so paths can be resolved against
 * import.meta.url instead of the CWD.
 *
 * Why absolute path: when the CLI is invoked as `node knex --knexfile
 * dist/db/knexfile.js migrate:latest`, knex resolves `directory:` against
 * the process working directory, NOT the knexfile location. A relative
 * `./migrations` then points at `/app/backend/migrations/` which doesn't
 * exist — the real files are at `/app/backend/dist/db/migrations/`. This
 * was the root cause of "migrations failed" rollbacks since v0.1.0.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Knex } from 'knex';
import { dataPath } from '../config.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(THIS_DIR, 'migrations');

// In dev (running via tsx) the migrations are .ts. In production
// (compiled to dist/) they're .js. Loading both can pick up .d.ts and
// crash.
const IS_PROD = process.env.NODE_ENV !== 'development';
const EXT: 'ts' | 'js' = IS_PROD ? 'js' : 'ts';

const baseMigrations: Knex.MigratorConfig = {
	directory: MIGRATIONS_DIR,
	extension: EXT,
	loadExtensions: [`.${EXT}`],
	disableTransactions: false,
};

const config: { [env: string]: Knex.Config } = {
	development: {
		client: 'better-sqlite3',
		connection: { filename: dataPath('db', 'db.sqlite') },
		useNullAsDefault: true,
		migrations: { ...baseMigrations, loadExtensions: ['.ts'] },
	},
	production: {
		client: 'better-sqlite3',
		connection: { filename: dataPath('db', 'db.sqlite') },
		useNullAsDefault: true,
		migrations: { ...baseMigrations, loadExtensions: ['.js'] },
	},
};

export default config;
