/**
 * Route-level tests for POST /api/setup and GET /api/setup/status.
 *
 * Spins up a real Express app (just express.json() + setupRouter, no nginx
 * in front) on an ephemeral loopback port and drives it with fetch — same
 * shape as tests/forwarded-header-probe.test.ts. `trust proxy` is left at
 * its Express default (false/off) on purpose: the guard under test reads
 * the raw X-Forwarded-For / CF-Connecting-IP headers itself (see
 * services/network-origin.ts), so it doesn't depend on Express's own
 * proxy-trust resolution of req.ip.
 *
 * All tests share one bootstrap (one fresh DB, zero users). Order matters:
 * the concurrency test is the one that actually creates the admin, so it
 * runs before the "second attempt" test that expects one to already exist.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-setup-route-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	// Deliberately NOT setting CLOUDGATE_INITIAL_ADMIN_PASSWORD — this is the
	// normal interactive-install path, so bootstrap must create zero users.
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);

	const { setupRouter } = await import('../src/routes/setup.js');
	const app = express();
	app.use(express.json());
	app.use('/api/setup', setupRouter);

	server = app.listen(0, '127.0.0.1');
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const port = (server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}/api/setup`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

const validBody = { email: 'me@example.com', name: 'Elias', password: 'correct-horse-battery-staple' };

describe('GET /api/setup/status — before setup', () => {
	it('reports needs_setup=true and an open window on a fresh install', async () => {
		const res = await fetch(`${base}/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.needs_setup).toBe(true);
		expect(body.window_open).toBe(true);
		expect(typeof body.window_closes_at).toBe('string');
	});
});

describe('POST /api/setup — guards (DB still empty)', () => {
	it('rejects a request whose X-Forwarded-For carries a public hop with SETUP_NOT_LOCAL', async () => {
		const res = await fetch(base, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.5' },
			body: JSON.stringify({ ...validBody, email: 'blocked-xff@example.com' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe('SETUP_NOT_LOCAL');
	});

	it('rejects any request carrying CF-Connecting-IP with SETUP_NOT_LOCAL', async () => {
		const res = await fetch(base, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
			body: JSON.stringify({ ...validBody, email: 'blocked-cf@example.com' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe('SETUP_NOT_LOCAL');
	});

	it('rejects once the setup window has elapsed with SETUP_WINDOW_CLOSED', async () => {
		const { PROCESS_STARTED_AT } = await import('../src/services/setup-window.js');
		// Default window is 30 minutes; fast-forward Date.now() past it for the
		// duration of this one request only.
		vi.spyOn(Date, 'now').mockReturnValue(PROCESS_STARTED_AT + 31 * 60_000);
		const res = await fetch(base, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...validBody, email: 'blocked-window@example.com' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).code).toBe('SETUP_WINDOW_CLOSED');
	});

	it('rejects an invalid payload with BAD_REQUEST', async () => {
		const res = await fetch(base, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'not-an-email', name: '', password: 'short' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe('BAD_REQUEST');
	});
});

describe('POST /api/setup — concurrent double submit', () => {
	it('creates exactly one user when two requests race', async () => {
		const [a, b] = await Promise.all([
			fetch(base, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...validBody, email: 'racer-a@example.com' }),
			}),
			fetch(base, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...validBody, email: 'racer-b@example.com' }),
			}),
		]);
		const statuses = [a.status, b.status].sort();
		// One wins (200, a real session), the other loses the race for the
		// single admin slot (409 SETUP_DONE) — never two 200s.
		expect(statuses).toEqual([200, 409]);

		const winner = a.status === 200 ? a : b;
		const winnerBody = await winner.json();
		expect(typeof winnerBody.access_token).toBe('string');
		expect(winnerBody.user.is_admin).toBe(true);
		expect(winnerBody.must_change_password).toBe(false);

		const { getDb } = await import('../src/db/db.js');
		const count = await getDb()('users').count<{ c: number }[]>({ c: '*' }).first();
		expect(Number(count?.c)).toBe(1);
	});
});

describe('POST /api/setup — after setup', () => {
	it('returns 409 SETUP_DONE for a further attempt', async () => {
		const res = await fetch(base, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...validBody, email: 'too-late@example.com' }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe('SETUP_DONE');
	});

	it('GET /status now reports needs_setup=false', async () => {
		const res = await fetch(`${base}/status`);
		expect((await res.json()).needs_setup).toBe(false);
	});
});
