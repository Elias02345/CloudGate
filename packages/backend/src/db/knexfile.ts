import type { Knex } from 'knex';
import { dataPath } from '../config.js';

const config: { [env: string]: Knex.Config } = {
	development: {
		client: 'better-sqlite3',
		connection: { filename: dataPath('db', 'db.sqlite') },
		useNullAsDefault: true,
		migrations: { directory: './migrations', extension: 'ts' },
	},
	production: {
		client: 'better-sqlite3',
		connection: { filename: dataPath('db', 'db.sqlite') },
		useNullAsDefault: true,
		migrations: { directory: './migrations', extension: 'ts' },
	},
};

export default config;
