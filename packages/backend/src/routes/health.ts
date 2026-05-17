import { existsSync, statSync } from 'node:fs';
import { Router, type Router as RouterType } from 'express';
import { dataPath, VERSION } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';

const log = childLogger('routes:health');
export const healthRouter: RouterType = Router();

/**
 * Light healthcheck — used by Docker HEALTHCHECK + smoke tests.
 * Cheap: just a SELECT 1 + version stamp.
 */
healthRouter.get('/', async (_req, res) => {
	let dbOk = false;
	try {
		const knex = getDb();
		await knex.raw('SELECT 1');
		dbOk = true;
	} catch {
		dbOk = false;
	}

	const status = dbOk ? 200 : 503;
	res.status(status).json({
		status: dbOk ? 'ok' : 'degraded',
		version: VERSION,
		db: dbOk,
		uptime_seconds: Math.round(process.uptime()),
		timestamp: new Date().toISOString(),
	});
});

/**
 * Deep healthcheck — used by Dashboard + ops folks.
 *
 * Returns subsystem-level status. Each check is bounded (no long timeouts),
 * never throws. Failed subsystems mark overall as 'degraded' but the endpoint
 * itself always returns 200 with the details — so dashboards can show *what*
 * is wrong.
 */
healthRouter.get('/deep', async (_req, res) => {
	const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};

	// DB ping
	const t0 = Date.now();
	try {
		const knex = getDb();
		await knex.raw('SELECT 1');
		checks.db = { ok: true, ms: Date.now() - t0 };
	} catch (err) {
		checks.db = { ok: false, detail: (err as Error).message };
	}

	// DB file size + WAL existence
	try {
		const dbStat = statSync(dataPath('db', 'db.sqlite'));
		checks.db_file = {
			ok: true,
			detail: `${(dbStat.size / 1024).toFixed(1)} KB`,
		};
	} catch {
		checks.db_file = { ok: false, detail: 'db.sqlite missing' };
	}

	// Secrets present (encryption.key, jwt.key)
	checks.secrets = {
		ok: existsSync(dataPath('secrets', 'encryption.key')) && existsSync(dataPath('secrets', 'jwt.key')),
		detail:
			existsSync(dataPath('secrets', 'encryption.key')) && existsSync(dataPath('secrets', 'jwt.key'))
				? 'encryption.key + jwt.key present'
				: 'missing key file(s) — bootstrap incomplete',
	};

	// Cloudflared daemon — best-effort metrics endpoint check
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 2000);
		const r = await fetch('http://127.0.0.1:36500/ready', { signal: ac.signal });
		clearTimeout(timer);
		checks.cloudflared = { ok: r.ok, detail: r.ok ? 'metrics endpoint healthy' : `HTTP ${r.status}` };
	} catch {
		checks.cloudflared = { ok: false, detail: 'metrics endpoint unreachable (daemon may be idle)' };
	}

	// Disk space on /data
	try {
		const fs = await import('node:fs/promises');
		// statfs is Node 18.15+ — exists on Linux. Fall back to 'ok' if unavailable.
		// biome-ignore lint/suspicious/noExplicitAny: statfs not in all type defs
		const statfsFn = (fs as any).statfs;
		if (typeof statfsFn === 'function') {
			const s = await statfsFn(dataPath());
			const freeMb = (s.bavail * s.bsize) / 1_048_576;
			const totalMb = (s.blocks * s.bsize) / 1_048_576;
			const pctFree = (freeMb / totalMb) * 100;
			checks.disk = {
				ok: freeMb > 100,
				detail: `${freeMb.toFixed(0)} MB free / ${totalMb.toFixed(0)} MB total (${pctFree.toFixed(1)}%)`,
			};
		} else {
			checks.disk = { ok: true, detail: 'statfs unsupported on this platform' };
		}
	} catch (err) {
		checks.disk = { ok: false, detail: (err as Error).message };
	}

	// GitHub reachability (for updater) — best effort
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 3000);
		const r = await fetch('https://api.github.com/zen', { signal: ac.signal });
		clearTimeout(timer);
		checks.github = { ok: r.ok, detail: r.ok ? 'reachable' : `HTTP ${r.status}` };
	} catch (err) {
		checks.github = { ok: false, detail: `unreachable: ${(err as Error).message}` };
	}

	const allOk = Object.values(checks).every((c) => c.ok);
	res.json({
		status: allOk ? 'ok' : 'degraded',
		version: VERSION,
		uptime_seconds: Math.round(process.uptime()),
		checks,
		timestamp: new Date().toISOString(),
	});
});

// Silence unused log import
void log;
