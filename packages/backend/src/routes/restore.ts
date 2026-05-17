/**
 * Restore endpoints.
 *
 *   GET  /api/restore/eligibility
 *        — whether a restore is allowed right now (data dir is empty)
 *        — public (no auth) so the first-run setup wizard can probe before login
 *
 *   POST /api/restore (multipart/form-data: file=backup.cgbk, passphrase=...)
 *        — admin-only restore on an EXISTING install (force overwrite)
 *
 *   POST /api/restore/first-run (multipart, no auth)
 *        — restore on a fresh container before any user is created.
 *          Refuses if /data already has db.sqlite.
 *
 * The first-run path is what the frontend Setup Wizard uses.
 */

import { existsSync } from 'node:fs';
import { Router, type Router as RouterType } from 'express';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';
import { requireAdmin, requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { dataDirHasInstall, RestoreError, restoreAndMark } from '../services/restore.js';

const log = childLogger('routes:restore');
export const restoreRouter: RouterType = Router();

const MAX_BACKUP_BYTES = 200 * 1024 * 1024; // 200MB

// ---------------------------------------------------------------------------
// GET /eligibility
// ---------------------------------------------------------------------------
restoreRouter.get('/eligibility', async (_req, res) => {
	const hasInstall = dataDirHasInstall();
	const bootstrapMarker = existsSync(dataPath('.bootstrap-complete'));
	res.json({
		fresh: !hasInstall && !bootstrapMarker,
		has_install: hasInstall,
		bootstrap_complete: bootstrapMarker,
	});
});

// ---------------------------------------------------------------------------
// POST /first-run — no auth, refuses if data already exists
// ---------------------------------------------------------------------------
restoreRouter.post('/first-run', async (req, res) => {
	if (dataDirHasInstall()) {
		res.status(409).json({
			error: 'An install already exists. Use the admin /restore endpoint with force=true to overwrite.',
			code: 'INSTALL_EXISTS',
		});
		return;
	}
	await handleRestore(req, res, { allowForce: false });
});

// ---------------------------------------------------------------------------
// POST / — admin-only, always allows force
// ---------------------------------------------------------------------------
restoreRouter.post('/', requireAuth, requirePasswordSet, requireAdmin, async (req, res) => {
	await handleRestore(req, res, { allowForce: true });
});

async function handleRestore(req: import('express').Request, res: import('express').Response, opts: { allowForce: boolean }): Promise<void> {
	const passphrase = (req.headers['x-cloudgate-passphrase'] as string) ?? '';
	if (passphrase.length < 8) {
		res.status(400).json({ error: 'Missing X-Cloudgate-Passphrase header (min 8 chars)', code: 'BAD_REQUEST' });
		return;
	}

	// Read raw body (the .cgbk file). Express's json middleware would have
	// already consumed JSON requests; this expects application/octet-stream.
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		await new Promise<void>((resolve, reject) => {
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BACKUP_BYTES) {
					reject(new Error(`backup file exceeds ${MAX_BACKUP_BYTES / 1024 / 1024}MB limit`));
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', resolve);
			req.on('error', reject);
		});
	} catch (err) {
		res.status(413).json({ error: (err as Error).message, code: 'PAYLOAD_TOO_LARGE' });
		return;
	}

	if (size === 0) {
		res.status(400).json({ error: 'Empty body — POST the .cgbk file as application/octet-stream', code: 'BAD_REQUEST' });
		return;
	}

	const buf = Buffer.concat(chunks);
	const force = opts.allowForce && req.query.force === 'true';

	try {
		const result = await restoreAndMark(buf, passphrase, { force });
		log.warn({ files: result.files, bytes: result.bytes, force }, 'RESTORE COMPLETED');
		res.json({
			ok: true,
			files: result.files,
			bytes: result.bytes,
			message: 'Restore complete — restart the container to load the new data.',
		});
	} catch (err) {
		if (err instanceof RestoreError) {
			res.status(err.code === 'DATA_DIR_NOT_EMPTY' ? 409 : 400).json({
				error: err.message,
				code: err.code,
			});
			return;
		}
		log.error({ err: (err as Error).message }, 'Restore crashed');
		res.status(500).json({ error: (err as Error).message, code: 'RESTORE_FAILED' });
	}
}
