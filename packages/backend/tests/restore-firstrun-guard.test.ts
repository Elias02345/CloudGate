/**
 * POST /api/restore/first-run is unauthenticated by design (it's how a
 * fresh container restores a previous install before any user exists), so
 * it gets the same window + private-network guards as POST /api/setup —
 * otherwise a stranger on the internet could restore their OWN backup onto
 * someone else's fresh container and become its admin.
 *
 * Only the guard is under test here; restore.test.ts covers the actual
 * decrypt/extract round-trip.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-restore-guard-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;

	const { restoreRouter } = await import('../src/routes/restore.js');
	const app = express();
	// Mounted the same way index.ts does — before express.json(), since the
	// route reads a raw octet-stream body itself.
	app.use('/api/restore', restoreRouter);

	server = app.listen(0, '127.0.0.1');
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const port = (server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}/api/restore`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/restore/first-run — guard', () => {
	it('rejects a request that looks like it came from the internet, even on an empty /data', async () => {
		const res = await fetch(`${base}/first-run`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/octet-stream',
				'X-Cloudgate-Passphrase': 'whatever-passphrase',
				'CF-Connecting-IP': '203.0.113.5',
			},
			body: Buffer.from('not a real backup'),
		});
		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.code).toBe('SETUP_NOT_LOCAL');
	});
});
