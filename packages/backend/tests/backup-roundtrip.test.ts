/**
 * Backup export → decrypt → tar contents test.
 *
 * Exercises the .cgbk on-disk format end to end:
 *   1. Bootstrap a fresh /data so secrets + DB exist.
 *   2. Write a marker file at /data/db/db.sqlite so tar has something
 *      identifiable inside (the real DB is included verbatim).
 *   3. Call the backup route's request handler directly via Express
 *      router invocation (avoid spinning up a port).
 *   4. Parse the response: header (magic+version+salt+iv) → decrypt the
 *      remaining bytes → assert the gzipped tar contains the marker file.
 *
 * This catches: wrong magic, wrong AES mode, mismatched key derivation,
 * truncated tar streams, and the "I forgot to include nginx/" class of bug.
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir: string;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-backup-rt-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
	const { runBootstrap } = await import('../src/bootstrap.js');
	const status = await runBootstrap();
	if (!status.complete) throw new Error(`bootstrap failed: ${status.last_error}`);
	// Drop a recognisable marker inside nginx/custom so we can prove the
	// extended backup picked it up.
	mkdirSync(join(tmpDir, 'nginx', 'custom'), { recursive: true });
	writeFileSync(join(tmpDir, 'nginx', 'custom', 'marker.conf'), 'server { # marker }', 'utf8');
});

afterAll(async () => {
	const { closeDb } = await import('../src/db/db.js');
	await closeDb();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('backup roundtrip', () => {
	it('produces a .cgbk that decrypts to a tar containing the marker', async () => {
		// Build a fake Request/Response pair and call the handler directly.
		const passphrase = 'roundtrip-test-pass';
		const chunks: Buffer[] = [];
		const fakeReq = {
			body: { passphrase },
			user: { id: 1, email: 'test@local', is_admin: true },
			ip: '127.0.0.1',
		} as unknown as import('express').Request;
		const headers: Record<string, string> = {};
		let statusCode = 200;
		const fakeRes = {
			setHeader(k: string, v: string) {
				headers[k.toLowerCase()] = v;
				return this;
			},
			status(c: number) {
				statusCode = c;
				return this;
			},
			get headersSent() {
				return false;
			},
			write(chunk: Buffer) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				return true;
			},
			end() {
				/* noop */
			},
			json(_payload: unknown) {
				/* error path */
			},
		} as unknown as import('express').Response;

		// Invoke the same handler path the POST route uses. We import the
		// internal helper rather than going through express to keep the test
		// hermetic — fewer middleware shenanigans.
		const backupModule = await import('../src/routes/backup.js');
		// The module exports the router; we exercise the export endpoint by
		// finding the registered POST handler.
		// biome-ignore lint/suspicious/noExplicitAny: introspection of express router internals
		const stack = (backupModule.backupRouter as any).stack as Array<{
			route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
		}>;
		const post = stack.find((s) => s.route?.path === '/' && s.route?.methods.post)?.route;
		if (!post) throw new Error('POST / handler not found in backupRouter');
		const handler = post.stack[post.stack.length - 1].handle as (
			req: import('express').Request,
			res: import('express').Response
		) => Promise<void>;

		await handler(fakeReq, fakeRes);
		// Allow the tar stream's async 'end' handler to fire.
		await new Promise((r) => setTimeout(r, 250));

		expect(statusCode).toBe(200);
		expect(headers['content-type']).toBe('application/octet-stream');
		const full = Buffer.concat(chunks);
		expect(full.length).toBeGreaterThan(64);

		// Parse header: magic(8) + version(1) + salt(16) + iv(12) + ciphertext... + tag(16)
		const MAGIC = Buffer.from('CGBACKUP', 'utf8');
		expect(full.subarray(0, 8).equals(MAGIC)).toBe(true);
		expect(full[8]).toBe(1);
		const salt = full.subarray(9, 25);
		const iv = full.subarray(25, 37);
		const tag = full.subarray(full.length - 16);
		const ciphertext = full.subarray(37, full.length - 16);

		const key = pbkdf2Sync(passphrase, salt, 200_000, 32, 'sha256');
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

		// Decrypted is gzipped tar. Gunzip + scan for our marker file path.
		const tar = gunzipSync(decrypted);
		const asText = tar.toString('binary');
		expect(asText).toContain('nginx/custom/marker.conf');
		expect(asText).toContain('db/db.sqlite');
		expect(asText).toContain('secrets/encryption.key');
	});

	it('rejects wrong passphrase on decrypt', () => {
		// Pure crypto sanity: same routine with a wrong key fails.
		const salt = Buffer.alloc(16, 1);
		const iv = Buffer.alloc(12, 2);
		const wrongKey = pbkdf2Sync('wrong-passphrase', salt, 200_000, 32, 'sha256');
		const decipher = createDecipheriv('aes-256-gcm', wrongKey, iv);
		decipher.setAuthTag(Buffer.alloc(16, 0));
		expect(() => decipher.update(Buffer.alloc(32))).not.toThrow();
		expect(() => decipher.final()).toThrow(/unable to authenticate/i);
	});
});

// Keep unused imports referenced so eslint doesn't strip them in a future pass.
void pipeline;
void Readable;
void readFileSync;
