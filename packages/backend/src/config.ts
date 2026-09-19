import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `z.coerce.boolean()` casts with JS's `Boolean(value)` — any non-empty
// string is truthy, so `CLOUDGATE_DISABLE_UPDATES=false` coerces to `true`.
// An operator setting that env var to the word "false" would silently
// disable updates instead of leaving them on. This parses the handful of
// values env vars actually use for booleans; anything else falls back to
// `fallback` rather than guessing.
function envBoolean(fallback: boolean) {
	return z.preprocess((value) => {
		if (typeof value !== 'string') return value;
		const v = value.trim().toLowerCase();
		if (['true', '1', 'yes', 'on'].includes(v)) return true;
		if (['false', '0', 'no', 'off', ''].includes(v)) return false;
		return value;
	}, z.boolean().default(fallback));
}

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
	CLOUDGATE_DISABLE_UPDATES: envBoolean(false),

	// Recovery / debug
	CLOUDGATE_RECOVERY_MODE: envBoolean(false),
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
		// Don't crash — a container that refuses to boot over one malformed
		// variable is worse than one running on defaults. But don't throw the
		// whole environment away either: the previous version fell back to
		// `parse({})`, so a single bad value (a non-numeric port, say) silently
		// discarded every *valid* setting alongside it. A custom
		// CLOUDGATE_DATA_DIR would stop being honoured and the app would write
		// to /data instead, looking perfectly healthy while doing it.
		// Default only the keys that actually failed.
		const invalid = new Set(result.error.issues.map((issue) => String(issue.path[0])));
		const kept = Object.fromEntries(Object.entries(process.env).filter(([key]) => !invalid.has(key)));
		console.error(
			`[config] Ignoring invalid env vars and using their defaults: ${[...invalid].join(', ')}`,
			result.error.flatten()
		);
		const retry = ConfigSchema.safeParse(kept);
		cached = retry.success ? retry.data : ConfigSchema.parse({});
		return cached;
	}
	cached = result.data;
	return cached;
}

export const VERSION = readVersion();

export function dataPath(...parts: string[]): string {
	// Read live env so tests can swap DATA_DIR per test-suite without restarting.
	// In production, env is set once at boot; this is essentially equivalent to caching.
	const dir = process.env.CLOUDGATE_DATA_DIR ?? getConfig().DATA_DIR;
	return join(dir, ...parts);
}
