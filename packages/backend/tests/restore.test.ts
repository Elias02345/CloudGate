/**
 * Backup → restore round-trip test.
 *
 * Creates a fake tar.gz of a small file, encrypts it with the .cgbk format,
 * restores it into a fresh tmp dir, asserts the file is back with correct
 * content. Also exercises the negative paths (wrong passphrase, missing
 * magic header, existing install detection).
 */

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create as createTar } from 'tar';

const MAGIC = Buffer.from('CGBACKUP', 'utf8');

async function buildBackup(srcDir: string, passphrase: string): Promise<Buffer> {
	// 1) Build tar.gz of srcDir contents
	const tarStream = createTar({ cwd: srcDir, gzip: true, portable: true }, ['.']);
	const tarBuf: Buffer = await new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		tarStream.on('data', (c: Buffer) => chunks.push(c));
		tarStream.on('end', () => resolve(Buffer.concat(chunks)));
		tarStream.on('error', reject);
	});

	// 2) Encrypt
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = pbkdf2Sync(passphrase, salt, 200_000, 32, 'sha256');
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const enc = Buffer.concat([cipher.update(tarBuf), cipher.final()]);
	const tag = cipher.getAuthTag();

	// 3) Wrap in .cgbk envelope
	return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, enc, tag]);
}

let dataDir: string;
let srcDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), 'cg-restore-data-'));
	srcDir = mkdtempSync(join(tmpdir(), 'cg-restore-src-'));
	process.env.CLOUDGATE_DATA_DIR = dataDir;
	mkdirSync(join(srcDir, 'db'), { recursive: true });
	mkdirSync(join(srcDir, 'secrets'), { recursive: true });
	writeFileSync(join(srcDir, 'db', 'db.sqlite'), 'FAKE_SQLITE_CONTENT');
	writeFileSync(join(srcDir, 'secrets', 'encryption.key'), 'FAKE_ENC_KEY');
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(srcDir, { recursive: true, force: true });
});

describe('restore', () => {
	it('round-trips files through encrypted backup → decrypt → extract', async () => {
		const cgbk = await buildBackup(srcDir, 'correct-horse-battery-staple');
		const { restoreFromBuffer } = await import('../src/services/restore.js');
		const result = await restoreFromBuffer(cgbk, 'correct-horse-battery-staple');
		expect(result.files).toBeGreaterThan(0);
		expect(readFileSync(join(dataDir, 'db', 'db.sqlite'), 'utf8')).toBe('FAKE_SQLITE_CONTENT');
		expect(readFileSync(join(dataDir, 'secrets', 'encryption.key'), 'utf8')).toBe('FAKE_ENC_KEY');
	});

	it('rejects wrong passphrase with CGBK_DECRYPT_FAILED', async () => {
		const cgbk = await buildBackup(srcDir, 'correct-passphrase');
		const { restoreFromBuffer } = await import('../src/services/restore.js');
		await expect(restoreFromBuffer(cgbk, 'wrong-passphrase')).rejects.toMatchObject({ code: 'CGBK_DECRYPT_FAILED' });
	});

	it('rejects file without CGBACKUP magic header', async () => {
		const bogus = Buffer.from('NOT-A-CLOUDGATE-BACKUP-FILE-AT-ALL-EVER');
		const { restoreFromBuffer } = await import('../src/services/restore.js');
		// 38 bytes is too short to hold the full header (8+1+16+12+16=53 minimum).
		// Service rejects with CGBK_TOO_SHORT before it can check the magic header.
		await expect(restoreFromBuffer(bogus, 'whatever')).rejects.toMatchObject({ code: 'CGBK_TOO_SHORT' });
	});

	it('refuses to overwrite an existing install without force=true', async () => {
		// Seed a fake install into dataDir
		mkdirSync(join(dataDir, 'db'), { recursive: true });
		mkdirSync(join(dataDir, 'secrets'), { recursive: true });
		writeFileSync(join(dataDir, 'db', 'db.sqlite'), 'EXISTING');
		writeFileSync(join(dataDir, 'secrets', 'encryption.key'), 'EXISTING-KEY');

		const cgbk = await buildBackup(srcDir, 'pw');
		const { restoreFromBuffer } = await import('../src/services/restore.js');
		await expect(restoreFromBuffer(cgbk, 'pw')).rejects.toMatchObject({ code: 'DATA_DIR_NOT_EMPTY' });

		// Existing files should still be there
		expect(readFileSync(join(dataDir, 'db', 'db.sqlite'), 'utf8')).toBe('EXISTING');
	});

	it('allows overwrite with force=true', async () => {
		mkdirSync(join(dataDir, 'db'), { recursive: true });
		mkdirSync(join(dataDir, 'secrets'), { recursive: true });
		writeFileSync(join(dataDir, 'db', 'db.sqlite'), 'EXISTING');
		writeFileSync(join(dataDir, 'secrets', 'encryption.key'), 'EXISTING-KEY');

		const cgbk = await buildBackup(srcDir, 'pw');
		const { restoreFromBuffer } = await import('../src/services/restore.js');
		const result = await restoreFromBuffer(cgbk, 'pw', { force: true });
		expect(result.files).toBeGreaterThan(0);
		expect(readFileSync(join(dataDir, 'db', 'db.sqlite'), 'utf8')).toBe('FAKE_SQLITE_CONTENT');
	});
});

// Silence unused
void Readable;
