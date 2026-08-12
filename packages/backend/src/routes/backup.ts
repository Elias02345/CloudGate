/**
 * Backup endpoint.
 *
 *   GET  /api/backup            — streams an encrypted .cgbk archive
 *   POST /api/backup            — same, accepts the passphrase in the body
 *                                  (used by the UI Download button — query-
 *                                  string passphrases would land in proxy
 *                                  access logs).
 *
 * Tar contents:
 *   db/db.sqlite          — all app state
 *   secrets/              — encryption.key + jwt.key (needed to decrypt
 *                            the per-row encrypted blobs in the DB)
 *   cloudflared/<uuid>.json   — CF tunnel credentials files
 *   cloudflared/config.yml    — rendered ingress (regenerable but cheap)
 *   nginx/custom/         — user-authored snippets
 *   nginx/certs/          — Let's Encrypt certs (rate-limited to re-issue)
 *
 * Skipped:
 *   cloudflared/bin/, playit/bin/  — downloadable
 *   logs/                          — large, low-value
 *
 * Format of the .cgbk file (single binary):
 *   magic(8)  = "CGBACKUP"
 *   version(1) = 1
 *   salt(16)
 *   iv(12)
 *   ciphertext + auth-tag(16)
 */

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type Request, type Response, Router, type Router as RouterType } from 'express';
import { create as createTar } from 'tar';
import { z } from 'zod';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';
import { requireAdmin, requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { record } from '../services/audit.js';

const log = childLogger('routes:backup');
export const backupRouter: RouterType = Router();

const BackupBodySchema = z.object({
	passphrase: z.string().min(8),
});

const MAGIC = Buffer.from('CGBACKUP', 'utf8');
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;

/** All paths we ship in a backup, relative to /data. */
const BACKUP_CANDIDATES = [
	'db/db.sqlite',
	'db/db.sqlite-wal',
	'db/db.sqlite-shm',
	'secrets',
	'cloudflared',
	'nginx/custom',
	'nginx/certs',
] as const;

async function handleBackup(req: Request, res: Response, passphrase: string): Promise<void> {
	const salt = randomBytes(SALT_LEN);
	const iv = randomBytes(IV_LEN);
	const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');

	const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const fileName = `cloudgate-backup-${dateStr}.cgbk`;
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

	const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv]);
	res.write(header);

	const cipher = createCipheriv('aes-256-gcm', key, iv);

	// Only pass paths that actually exist — tar errors on missing entries
	// in some configurations, and we'd rather quietly skip than fail the
	// whole backup because (e.g.) nginx/certs is empty on a fresh install.
	const includePaths = BACKUP_CANDIDATES.filter((p) => existsSync(dataPath(p)));
	if (includePaths.length === 0) {
		res.status(500).json({ error: 'no backup-eligible files found', code: 'BACKUP_EMPTY' });
		return;
	}

	// Cloudflared keeps the daemon binary under /data/cloudflared/bin which
	// can be ~50MB and is downloadable anyway. Filter it out via tar's
	// `filter` callback.
	const tarStream = createTar(
		{
			cwd: dataPath(),
			gzip: true,
			portable: true,
			noMtime: false,
			filter: (path) => {
				if (path.startsWith('cloudflared/bin') || path === 'cloudflared/bin') return false;
				return true;
			},
		},
		[...includePaths]
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
		log.info({ user: req.user?.email, includes: includePaths }, 'Backup exported');
	});
}

// GET form — passphrase in query (legacy / curl convenience). Passphrase
// will appear in access logs — POST is preferred from the UI.
backupRouter.get('/', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	const parsed = BackupBodySchema.safeParse(req.query);
	if (!parsed.success) {
		res.status(400).json({
			error: 'passphrase query parameter required (min 8 chars)',
			code: 'BAD_REQUEST',
		});
		return;
	}
	await handleBackup(req, res, parsed.data.passphrase);
});

// POST form — passphrase in body. Used by the SPA so the secret doesn't
// land in proxy / nginx access logs.
backupRouter.post('/', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	const parsed = BackupBodySchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({
			error: 'passphrase body field required (min 8 chars)',
			code: 'BAD_REQUEST',
		});
		return;
	}
	await handleBackup(req, res, parsed.data.passphrase);
});
