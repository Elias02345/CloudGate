/**
 * CloudGate Bootstrap — runs on every container start.
 *
 * GUARANTEES:
 * - Idempotent: safe to re-run any number of times.
 * - Never overwrites existing user data (see CLAUDE.md §1).
 * - Each step has its own try/catch; failure routes to Recovery UI, not container crash.
 * - Generates missing secrets; uses existing ones if present.
 *
 * See CLAUDE.md §2 and docs/UPDATE_RULES.md §2 for the contract.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BootstrapStatus, BootstrapStep, BootstrapStepName } from '@cloudgate/shared';
import { BOOTSTRAP_STEPS } from '@cloudgate/shared';
import argon2 from 'argon2';
import { dataPath, getConfig, VERSION } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('bootstrap');

const STEP_RUNNERS: Record<BootstrapStepName, () => Promise<void>> = {
	'disk-health': checkDiskHealth,
	'ensure-data-dirs': ensureDataDirs,
	'ensure-secrets': ensureSecrets,
	'init-db': initDb,
	'run-migrations': runMigrations,
	'seed-admin-if-missing': seedAdminIfMissing,
	'init-gpg-keyring': initGpgKeyring,
	'cleanup-stale-files': cleanupStaleFiles,
	'write-marker': writeMarker,
};

export async function runBootstrap(): Promise<BootstrapStatus> {
	const steps: BootstrapStep[] = [];
	let lastError: string | null = null;
	const cfg = getConfig();

	if (cfg.CLOUDGATE_RECOVERY_MODE) {
		log.warn('CLOUDGATE_RECOVERY_MODE=true — skipping bootstrap, recovery UI should serve');
		return {
			complete: false,
			steps,
			last_error: 'Recovery mode forced via ENV',
			version: VERSION,
		};
	}

	log.info({ version: VERSION }, 'Starting bootstrap');

	for (const stepName of BOOTSTRAP_STEPS) {
		const step: BootstrapStep = {
			name: stepName,
			status: 'running',
			error: null,
			started_at: new Date().toISOString(),
			finished_at: null,
		};
		steps.push(step);

		try {
			await STEP_RUNNERS[stepName]();
			step.status = 'completed';
			step.finished_at = new Date().toISOString();
			log.info({ step: stepName }, 'Bootstrap step completed');
		} catch (err) {
			step.status = 'failed';
			step.error = err instanceof Error ? err.message : String(err);
			step.finished_at = new Date().toISOString();
			lastError = step.error;
			log.error({ step: stepName, err }, 'Bootstrap step failed');
			// Write the error marker so Recovery UI can show what happened.
			try {
				await writeFile(
					dataPath('.bootstrap-error'),
					JSON.stringify({ step: stepName, error: step.error, when: step.finished_at }, null, 2),
					'utf8'
				);
			} catch {
				/* best effort */
			}
			return { complete: false, steps, last_error: lastError, version: VERSION };
		}
	}

	// On success, remove any old error marker.
	try {
		await unlink(dataPath('.bootstrap-error'));
	} catch {
		/* nothing to clean */
	}

	log.info('Bootstrap complete');
	return { complete: true, steps, last_error: null, version: VERSION };
}

// ===========================================================================
// Step implementations
// ===========================================================================

async function checkDiskHealth(): Promise<void> {
	// dataPath() reads live env (CLOUDGATE_DATA_DIR) — important for tests that
	// swap data dirs after module load.
	const dir = dataPath();
	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		throw new Error(`Cannot create or access DATA_DIR (${dir}): ${(err as Error).message}`);
	}
	const probe = dataPath('.write-probe');
	try {
		await writeFile(probe, 'ok', 'utf8');
		await unlink(probe);
	} catch (err) {
		throw new Error(`DATA_DIR (${dir}) is not writable: ${(err as Error).message}`);
	}
}

async function ensureDataDirs(): Promise<void> {
	const dirs = [
		dataPath('secrets'),
		dataPath('db'),
		dataPath('db', 'backups'),
		dataPath('cloudflared'),
		dataPath('cloudflared', 'bin'),
		dataPath('nginx', 'hosts'),
		dataPath('nginx', 'custom'),
		dataPath('nginx', 'certs'),
		dataPath('logs'),
		dataPath('updates', 'staging'),
		dataPath('updates', 'backups'),
	];
	for (const d of dirs) {
		await mkdir(d, { recursive: true });
	}
	// Tighten secrets/ permissions
	try {
		await chmod(dataPath('secrets'), 0o700);
	} catch {
		/* not fatal on Windows or non-POSIX */
	}
}

/**
 * Read-or-generate idiom (see CLAUDE.md §2).
 * Never regenerates if file exists.
 */
async function ensureSecret(path: string, lengthBytes: number, envOverride?: string): Promise<string> {
	if (existsSync(path)) {
		const value = (await readFile(path, 'utf8')).trim();
		if (value.length > 0) return value;
		log.warn({ path }, 'Existing secret file is empty — regenerating');
	}

	const value = envOverride ?? randomBytes(lengthBytes).toString('base64');
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		/* not fatal */
	}
	log.info({ path, generated: !envOverride }, 'Secret materialized');
	return value;
}

async function ensureSecrets(): Promise<void> {
	const cfg = getConfig();
	await ensureSecret(dataPath('secrets', 'encryption.key'), 32, cfg.CLOUDGATE_ENCRYPTION_KEY);
	await ensureSecret(dataPath('secrets', 'jwt.key'), 32, cfg.CLOUDGATE_JWT_SECRET);
}

async function initDb(): Promise<void> {
	const dbPath = dataPath('db', 'db.sqlite');
	if (!existsSync(dbPath)) {
		// Touch the file so SQLite can pick it up — Knex will populate.
		await writeFile(dbPath, '', { flag: 'wx' }).catch(() => {
			// Race condition or perms — Knex will report a real error later.
		});
		log.info({ path: dbPath }, 'Created empty DB file');
	}
}

async function runMigrations(): Promise<void> {
	// Lazy import so failure-to-import doesn't fail earlier safety checks.
	const { getDb } = await import('./db/db.js');
	const knex = getDb();
	const [batchNo, migrations] = await knex.migrate.latest();
	log.info({ batchNo, migrations }, 'Migrations applied');
}

async function seedAdminIfMissing(): Promise<void> {
	const cfg = getConfig();
	const { getDb } = await import('./db/db.js');
	const knex = getDb();

	const existing = await knex('users').count<{ c: number }[]>({ c: '*' }).first();
	if (existing && Number(existing.c) > 0) {
		log.debug('Admin user already exists, skipping seed');
		return;
	}

	const email = cfg.CLOUDGATE_INITIAL_ADMIN_EMAIL ?? 'admin@cloudgate.local';
	const password = cfg.CLOUDGATE_INITIAL_ADMIN_PASSWORD ?? randomBytes(18).toString('base64');
	const hash = await argon2.hash(password, { type: argon2.argon2id });

	await knex('users').insert({
		email,
		password_hash: hash,
		name: 'Admin',
		is_admin: true,
		must_change_password: true,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	});

	// Write the initial password ONCE so the user can find it (gets deleted on first login).
	const adminFile = dataPath('secrets', 'initial-admin.txt');
	const content = [
		'CloudGate Initial Admin Credentials',
		'====================================',
		'',
		`Email:    ${email}`,
		`Password: ${password}`,
		'',
		'You will be forced to change this password on first login.',
		'This file is automatically deleted once you log in successfully.',
		'',
	].join('\n');
	await writeFile(adminFile, content, { encoding: 'utf8', mode: 0o600 });

	// Also log it loudly — once.
	log.warn(
		{ email, password_file: adminFile },
		'====== INITIAL ADMIN PASSWORD (shown once, also saved to /data/secrets/initial-admin.txt) ======'
	);
	log.warn(`Initial admin password: ${password}`);
	log.warn('======================================================================================');
}

async function initGpgKeyring(): Promise<void> {
	// Lazy: only required for the auto-updater. Stub for now — proper implementation in M5.
	const keyringDir = dataPath('secrets', 'gpg-keyring');
	await mkdir(keyringDir, { recursive: true });
	try {
		await chmod(keyringDir, 0o700);
	} catch {
		/* not fatal */
	}
	log.debug('GPG keyring dir ensured (import deferred until updater service runs)');
}

async function cleanupStaleFiles(): Promise<void> {
	// Stub: in production this removes leftover update-staging, rotates backups, etc.
	// Keeping minimal in M0 so we don't accidentally delete user files via an immature heuristic.
	log.debug('Cleanup pass (no-op in M0)');
}

async function writeMarker(): Promise<void> {
	const marker = dataPath('.bootstrap-complete');
	const payload = {
		version: VERSION,
		when: new Date().toISOString(),
	};
	await writeFile(marker, JSON.stringify(payload, null, 2), 'utf8');
	// Also drop a /data/.version file so the updater can read it without spinning up the backend.
	await writeFile(dataPath('.version'), VERSION, 'utf8');
}

/**
 * Read the previous bootstrap status if any (used by Recovery UI).
 */
export async function readBootstrapMarker(): Promise<{ version: string; when: string } | null> {
	const marker = dataPath('.bootstrap-complete');
	if (!existsSync(marker)) return null;
	try {
		const raw = await readFile(marker, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Delete the initial-admin.txt once user has logged in.
 * Called from the auth route after a successful first password change.
 */
export async function clearInitialAdminFile(): Promise<void> {
	const adminFile = dataPath('secrets', 'initial-admin.txt');
	try {
		await unlink(adminFile);
		log.info('Removed /data/secrets/initial-admin.txt after first login');
	} catch {
		/* file may not exist — fine */
	}
}

// Allow direct invocation: `node dist/bootstrap.js` (used by Docker entrypoint).
if (import.meta.url === `file://${process.argv[1]}`) {
	runBootstrap()
		.then((status) => {
			if (!status.complete) {
				console.error('Bootstrap failed:', status.last_error);
				process.exit(2);
			}
			process.exit(0);
		})
		.catch((err) => {
			console.error('Bootstrap crashed:', err);
			process.exit(1);
		});
}

