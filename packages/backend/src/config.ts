import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ConfigSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	BIND_ADDRESS: z.string().default('127.0.0.1'),
	DATA_DIR: z.string().default('/data'),
	LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

	// Bootstrap overrides — read once at first run, then ignored
	CLOUDGATE_INITIAL_ADMIN_EMAIL: z.string().email().optional(),
	CLOUDGATE_INITIAL_ADMIN_PASSWORD: z.string().min(12).optional(),
	CLOUDGATE_ENCRYPTION_KEY: z.string().optional(),
	CLOUDGATE_JWT_SECRET: z.string().optional(),

	// Update settings — initial only, override-able via UI
	CLOUDGATE_UPDATE_CHANNEL: z.enum(['stable', 'prerelease', 'nightly', 'disabled']).default('stable'),
	CLOUDGATE_UPDATE_MODE: z.enum(['auto', 'notify', 'scheduled']).default('notify'),
	CLOUDGATE_UPDATE_REPO: z.string().default('Elias02345/CloudGate'),
	CLOUDGATE_GITHUB_TOKEN: z.string().optional(),
	CLOUDGATE_DISABLE_UPDATES: z.coerce.boolean().default(false),

	// Recovery / debug
	CLOUDGATE_RECOVERY_MODE: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function readVersion(): string {
	try {
		const versionPath = join(__dirname, '..', '.version');
		return readFileSync(versionPath, 'utf8').trim();
	} catch {
		try {
			const pkgPath = join(__dirname, '..', 'package.json');
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			return pkg.version ?? '0.0.0-dev';
		} catch {
			return '0.0.0-dev';
		}
	}
}

let cached: Config | null = null;

export function getConfig(): Config {
	if (cached) return cached;
	const result = ConfigSchema.safeParse(process.env);
	if (!result.success) {
		// Even on parse failure we don't crash — fall through to safe defaults.
		// (Schema has defaults for everything; .safeParse mostly fails on bad coercion.)
		console.error('[config] Some env vars failed validation, using safe defaults:', result.error.flatten());
		cached = ConfigSchema.parse({});
		return cached;
	}
	cached = result.data;
	return cached;
}

export const VERSION = readVersion();

export function dataPath(...parts: string[]): string {
	return join(getConfig().DATA_DIR, ...parts);
}
