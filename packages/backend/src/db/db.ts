import knex, { type Knex } from 'knex';
import { dataPath } from '../config.js';

let cached: Knex | null = null;

export function getDb(): Knex {
	if (cached) return cached;
	cached = knex({
		client: 'better-sqlite3',
		connection: {
			filename: dataPath('db', 'db.sqlite'),
		},
		useNullAsDefault: true,
		pool: {
			afterCreate: (conn: { pragma: (sql: string) => void }, done: (err: Error | null) => void) => {
				// WAL = good concurrency. Foreign keys ON = referential integrity.
				try {
					conn.pragma('journal_mode = WAL');
					conn.pragma('foreign_keys = ON');
					conn.pragma('synchronous = NORMAL');
					done(null);
				} catch (err) {
					done(err as Error);
				}
			},
		},
		migrations: {
			directory: new URL('./migrations/', import.meta.url).pathname,
			extension: 'ts',
			loadExtensions: ['.ts', '.js'],
		},
	});
	return cached;
}

export async function closeDb(): Promise<void> {
	if (cached) {
		await cached.destroy();
		cached = null;
	}
}
