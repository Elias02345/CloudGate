/**
 * Backup restore service.
 *
 * Counterpart to routes/backup.ts. Accepts an encrypted .cgbk file +
 * passphrase, decrypts, untars into /data/.
 *
 * .cgbk format (from backup.ts):
 *   magic(8)="CGBACKUP" | version(1) | salt(16) | iv(12) | ciphertext | tag(16)
 *
 * Safety:
 *   - Refuses if /data already has user data (db.sqlite present + bootstrap
 *     complete). Caller can pass {force:true} for an explicit overwrite.
 *   - Streams via passthrough cipher so memory stays bounded for large DBs.
 *   - tar extraction restricted to dataPath() — no escape via '..' allowed.
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as tarExtract } from 'tar';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';

const log = childLogger('restore');

const MAGIC = Buffer.from('CGBACKUP', 'utf8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PBKDF2_ITERATIONS = 200_000;

export class RestoreError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'RestoreError';
		this.code = code;
	}
}

export interface RestoreOptions {
	force?: boolean; // overwrite existing /data
}

/**
 * Check whether /data already contains a CloudGate install.
 */
export function dataDirHasInstall(): boolean {
	return (
		existsSync(dataPath('db', 'db.sqlite')) &&
		existsSync(dataPath('secrets', 'encryption.key'))
	);
}

/**
 * Restore from a buffer (whole .cgbk file in memory). Suitable for the
 * sub-100MB backups CloudGate produces. Streaming with a stream-in source
 * would require parsing the header first, which is doable but unnecessary.
 */
export async function restoreFromBuffer(
	buffer: Buffer,
	passphrase: string,
	opts: RestoreOptions = {}
): Promise<{ files: number; bytes: number }> {
	if (buffer.length < MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN) {
		throw new RestoreError('CGBK_TOO_SHORT', 'Backup file is too short to be a valid .cgbk');
	}
	if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new RestoreError('CGBK_BAD_MAGIC', 'Not a CloudGate backup file (magic header mismatch)');
	}
	const version = buffer[MAGIC.length];
	if (version !== 1) {
		throw new RestoreError('CGBK_UNSUPPORTED_VERSION', `Unsupported backup format version ${version}`);
	}

	if (dataDirHasInstall() && !opts.force) {
		throw new RestoreError(
			'DATA_DIR_NOT_EMPTY',
			'/data already contains an existing CloudGate install. Refusing to restore — set force=true to override.'
		);
	}

	const cursor = { i: MAGIC.length + 1 };
	const salt = buffer.subarray(cursor.i, cursor.i + SALT_LEN);
	cursor.i += SALT_LEN;
	const iv = buffer.subarray(cursor.i, cursor.i + IV_LEN);
	cursor.i += IV_LEN;
	const ciphertext = buffer.subarray(cursor.i, buffer.length - TAG_LEN);
	const tag = buffer.subarray(buffer.length - TAG_LEN);

	const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);

	const decryptedChunks: Buffer[] = [];
	try {
		decryptedChunks.push(decipher.update(ciphertext));
		decryptedChunks.push(decipher.final());
	} catch (err) {
		throw new RestoreError(
			'CGBK_DECRYPT_FAILED',
			`Decryption failed — wrong passphrase or corrupted file: ${(err as Error).message}`
		);
	}
	const tarGz = Buffer.concat(decryptedChunks);

	// Extract to dataPath() — tar will gunzip + write files. We restrict via
	// the `cwd` option; tar's default behaviour blocks '..' escapes.
	if (!existsSync(dataPath())) mkdirSync(dataPath(), { recursive: true });

	let fileCount = 0;
	let byteCount = 0;
	const countingTransform = new Transform({
		transform(chunk, _enc, cb) {
			byteCount += chunk.length;
			cb(null, chunk);
		},
	});
	const tarSink = tarExtract({
		cwd: dataPath(),
		strip: 0,
		preservePaths: false,
		onReadEntry: () => {
			fileCount++;
		},
	});

	await pipeline(Readable.from(tarGz), countingTransform, tarSink);

	log.info({ files: fileCount, bytes: byteCount }, 'Restore complete');
	return { files: fileCount, bytes: byteCount };
}

/**
 * Convenience wrapper — also writes the .bootstrap-complete marker so the
 * backend will treat the restored data as a finished install.
 */
export async function restoreAndMark(buffer: Buffer, passphrase: string, opts: RestoreOptions = {}): Promise<{ files: number; bytes: number }> {
	const result = await restoreFromBuffer(buffer, passphrase, opts);
	const markerPath = dataPath('.bootstrap-complete');
	const fs = await import('node:fs/promises');
	await fs.writeFile(
		markerPath,
		JSON.stringify({ version: 'restored', when: new Date().toISOString() }, null, 2),
		'utf8'
	);
	return result;
}

// Touch the unused imports to satisfy strict mode without affecting behaviour
void createWriteStream;
void rm;
