/**
 * Backup endpoint.
 *
 *   GET /api/backup           — streams a tar.gz containing /data/db/db.sqlite
 *                                and /data/secrets/. The tar is then encrypted
 *                                with the user-supplied passphrase (PBKDF2 → AES-GCM).
 *                                Caller should pipe to file: `curl -o backup.cgbk ...`
 *
 * Format of the .cgbk file (single binary):
 *   magic(8)  = "CGBACKUP"
 *   version(1) = 1
 *   salt(16)
 *   iv(12)
 *   ciphertext + auth-tag(16)
 *
 * Decryption is symmetric — user keeps the passphrase, no other key needed.
 * (This is a separate path from the at-rest encryption.key — backups must be
 *  portable across machines.)
 */

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { create as createTar } from 'tar';
import { z } from 'zod';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet, requireAdmin } from '../middleware/auth.js';
import { record } from '../services/audit.js';

const log = childLogger('routes:backup');
export const backupRouter: RouterType = Router();

const BackupQuerySchema = z.object({
	passphrase: z.string().min(8),
});

const MAGIC = Buffer.from('CGBACKUP', 'utf8');
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;

backupRouter.get('/', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	const parsed = BackupQuerySchema.safeParse(req.query);
	if (!parsed.success) {
		res.status(400).json({
			error: 'passphrase query parameter required (min 8 chars)',
			code: 'BAD_REQUEST',
		});
		return;
	}
	const { passphrase } = parsed.data;

	const salt = randomBytes(SALT_LEN);
	const iv = randomBytes(IV_LEN);
	const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

	const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const fileName = `cloudgate-backup-${dateStr}.cgbk`;
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

	// Stream header
	const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv]);
	res.write(header);

	const cipher = createCipheriv('aes-256-gcm', key, iv);
	// Build the tarball: include only the paths we want.
	const tarStream = createTar(
		{
			cwd: dataPath(),
			gzip: true,
			portable: true,
			noMtime: false,
		},
		[
			// Order matters only cosmetically. Sacred paths per CLAUDE.md §10.3.
			'db/db.sqlite',
			'secrets',
			'cloudflared',
		].filter((p) => p) // tar filters out non-existent on its own
	);

	tarStream.on('error', (err: unknown) => {
		log.error({ err: (err as Error).message }, 'tar pipeline error');
		if (!res.headersSent) res.status(500).json({ error: 'tar failed', code: 'BACKUP_FAILED' });
	});

	tarStream.on('data', (chunk: Buffer) => {
		const enc = cipher.update(chunk);
		if (enc.length > 0) res.write(enc);
	});

	tarStream.on('end', () => {
		const final = cipher.final();
		const tag = cipher.getAuthTag();
		if (final.length > 0) res.write(final);
		res.write(tag);
		res.end();
		record({
			user_id: req.user?.id ?? null,
			action: 'backup.exported',
			entity_type: 'backup',
			ip: req.ip ?? null,
		});
		log.info({ user: req.user?.email }, 'Backup exported');
	});
});
