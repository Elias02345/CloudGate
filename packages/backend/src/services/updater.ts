/**
 * Self-Updater service.
 *
 * Polls GitHub releases for a newer version, optionally downloads + verifies +
 * installs the new code in-place. Follows the persistence contract from
 * CLAUDE.md §1 — /data/ paths are NEVER touched, only /app/ is replaced.
 *
 * Lifecycle:
 *   - init() spawns the polling cron
 *   - getStatus() returns current state for the UI
 *   - triggerCheck() forces an immediate poll
 *   - triggerInstall(version) starts the install pipeline asynchronously
 *
 * For M5 we ship the polling + download + GPG-verify pipeline. The actual
 * /app/ swap + DB migration runs through bin/apply-update.sh inside the
 * container (privileged ops). The first signed release on `main` will make
 * the loop complete; until then, `notify` mode just shows the banner.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VERSION, dataPath, getConfig } from '../config.js';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { record } from './audit.js';
import { publish } from './events.js';

const log = childLogger('updater');

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const STAGING_DIR_NAME = 'updates/staging';
const LOCK_FILE = 'updates/.update.lock';

// -------------------------------- state ------------------------------------

export type InstallStep =
	| 'acquire_lock'
	| 'download_archive'
	| 'download_sha'
	| 'download_sig'
	| 'verify_sha'
	| 'verify_gpg'
	| 'spawn_apply'
	| 'apply_running'
	| 'done'
	| 'failed';

interface UpdaterState {
	current_version: string;
	latest_version: string | null;
	update_available: boolean;
	state:
		| 'idle'
		| 'checking'
		| 'available'
		| 'downloading'
		| 'verifying'
		| 'installing'
		| 'rolling_back'
		| 'failed';
	last_checked_at: string | null;
	channel: 'stable' | 'prerelease' | 'nightly' | 'disabled';
	mode: 'auto' | 'notify' | 'scheduled';
	last_error: string | null;
	release_notes_url: string | null;

	// Install-time fine-grained progress
	step: InstallStep | null;
	step_label: string | null;
	overall_progress: number | null;
	download_bytes: number | null;
	download_total: number | null;
	started_at: string | null;
	target_version: string | null;
}

let state: UpdaterState = {
	current_version: VERSION,
	latest_version: null,
	update_available: false,
	state: 'idle',
	last_checked_at: null,
	channel: 'stable',
	mode: 'notify',
	last_error: null,
	release_notes_url: null,
	step: null,
	step_label: null,
	overall_progress: null,
	download_bytes: null,
	download_total: null,
	started_at: null,
	target_version: null,
};

function setStateField<K extends keyof UpdaterState>(key: K, value: UpdaterState[K]): void {
	state = { ...state, [key]: value };
}

export function getStatus(): UpdaterState {
	return { ...state };
}

/**
 * Cumulative overall-progress percentage per step. The download_archive
 * step is interpolated (its own percentage scales linearly with bytes
 * downloaded between START and END).
 */
const STEP_PROGRESS: Record<InstallStep, { start: number; end: number; label: string }> = {
	acquire_lock: { start: 0, end: 2, label: 'Reserving update slot' },
	download_archive: { start: 2, end: 50, label: 'Downloading release tarball' },
	download_sha: { start: 50, end: 52, label: 'Downloading SHA256 sidecar' },
	download_sig: { start: 52, end: 54, label: 'Downloading GPG signature' },
	verify_sha: { start: 54, end: 58, label: 'Verifying SHA256 checksum' },
	verify_gpg: { start: 58, end: 62, label: 'Verifying GPG signature' },
	spawn_apply: { start: 62, end: 65, label: 'Handing off to in-container applier' },
	apply_running: { start: 65, end: 95, label: 'Applying update (container is restarting)' },
	done: { start: 100, end: 100, label: 'Done' },
	failed: { start: 0, end: 0, label: 'Failed' },
};

/**
 * Set the current step and broadcast a progress event. Pass `fraction` for
 * intra-step progress (0..1, only meaningful for download_archive).
 */
function setStep(step: InstallStep, fraction = 0): void {
	const meta = STEP_PROGRESS[step];
	const overall = Math.round(meta.start + (meta.end - meta.start) * Math.max(0, Math.min(1, fraction)));
	state = {
		...state,
		step,
		step_label: meta.label,
		overall_progress: overall,
	};
	publish('update.progress', {
		step,
		step_label: meta.label,
		overall_progress: overall,
		download_bytes: state.download_bytes,
		download_total: state.download_total,
		target_version: state.target_version,
	});
}

function resetProgress(): void {
	state = {
		...state,
		step: null,
		step_label: null,
		overall_progress: null,
		download_bytes: null,
		download_total: null,
		started_at: null,
		target_version: null,
	};
}

// -------------------------------- channel ----------------------------------

async function loadSettings(): Promise<void> {
	const knex = getDb();
	const rows = await knex<{ key: string; value: string }>('settings').whereIn('key', [
		'update_channel',
		'update_mode',
	]);
	for (const r of rows) {
		try {
			const v = JSON.parse(r.value);
			if (r.key === 'update_channel' && typeof v === 'string') {
				setStateField('channel', v as UpdaterState['channel']);
			}
			if (r.key === 'update_mode' && typeof v === 'string') {
				setStateField('mode', v as UpdaterState['mode']);
			}
		} catch {
			/* malformed setting — ignore */
		}
	}
}

export async function updateChannel(
	channel: UpdaterState['channel'],
	mode: UpdaterState['mode']
): Promise<void> {
	const knex = getDb();
	const now = new Date().toISOString();
	await knex('settings')
		.insert([
			{ key: 'update_channel', value: JSON.stringify(channel), updated_at: now },
			{ key: 'update_mode', value: JSON.stringify(mode), updated_at: now },
		])
		.onConflict('key')
		.merge();
	setStateField('channel', channel);
	setStateField('mode', mode);
}

// -------------------------------- polling ----------------------------------

function pickReleaseForChannel(
	releases: Array<{
		tag_name: string;
		prerelease: boolean;
		html_url: string;
		assets: Array<{ name: string; browser_download_url: string }>;
	}>,
	channel: UpdaterState['channel']
): (typeof releases)[number] | null {
	if (channel === 'disabled') return null;
	for (const r of releases) {
		const isPrerelease = r.prerelease || /-(?:rc|beta|nightly)\.?/i.test(r.tag_name);
		const isNightly = /-nightly\.?/i.test(r.tag_name);
		if (channel === 'stable' && !isPrerelease) return r;
		if (channel === 'prerelease' && !isNightly) return r;
		if (channel === 'nightly') return r;
	}
	return null;
}

function compareVersions(a: string, b: string): number {
	// Strip leading "v" and any pre-release suffix for comparison
	const norm = (s: string) =>
		s
			.replace(/^v/, '')
			.split(/[.+-]/)
			.map((p) => Number.parseInt(p, 10));
	const [aMaj, aMin, aPat] = norm(a);
	const [bMaj, bMin, bPat] = norm(b);
	const score = (x: number | undefined) => (Number.isFinite(x) ? (x as number) : 0);
	if (score(aMaj) !== score(bMaj)) return score(aMaj) - score(bMaj);
	if (score(aMin) !== score(bMin)) return score(aMin) - score(bMin);
	return score(aPat) - score(bPat);
}

export async function triggerCheck(): Promise<void> {
	const cfg = getConfig();
	if (cfg.CLOUDGATE_DISABLE_UPDATES) {
		log.debug('Updates disabled via ENV — skipping check');
		return;
	}
	if (state.channel === 'disabled') {
		log.debug('Update channel set to disabled — skipping check');
		return;
	}

	setStateField('state', 'checking');
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': `CloudGate/${VERSION}`,
	};
	if (cfg.CLOUDGATE_GITHUB_TOKEN) headers.Authorization = `Bearer ${cfg.CLOUDGATE_GITHUB_TOKEN}`;

	try {
		const url = `https://api.github.com/repos/${cfg.CLOUDGATE_UPDATE_REPO}/releases?per_page=20`;
		const res = await fetch(url, { headers });
		if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
		const releases = (await res.json()) as Array<{
			tag_name: string;
			prerelease: boolean;
			html_url: string;
			assets: Array<{ name: string; browser_download_url: string }>;
		}>;
		const pick = pickReleaseForChannel(releases, state.channel);
		setStateField('last_checked_at', new Date().toISOString());

		if (!pick) {
			setStateField('state', 'idle');
			setStateField('update_available', false);
			setStateField('latest_version', null);
			return;
		}

		const latest = pick.tag_name;
		const cmp = compareVersions(latest, VERSION);
		setStateField('latest_version', latest);
		setStateField('release_notes_url', pick.html_url);

		if (cmp > 0) {
			setStateField('update_available', true);
			setStateField('state', 'available');
			publish('update.available', { version: latest, url: pick.html_url });
			log.info({ current: VERSION, latest }, 'Update available');

			if (state.mode === 'auto') {
				// Kick off install asynchronously
				void triggerInstall(latest).catch((err) =>
					log.error({ err: (err as Error).message }, 'Auto-install failed')
				);
			}
		} else {
			setStateField('update_available', false);
			setStateField('state', 'idle');
		}
	} catch (err) {
		setStateField('state', 'failed');
		setStateField('last_error', (err as Error).message);
		log.warn({ err: (err as Error).message }, 'Update check failed');
	}
}

// -------------------------------- install ----------------------------------

async function acquireLock(): Promise<boolean> {
	const lockPath = dataPath(LOCK_FILE);
	await mkdir(dataPath('updates'), { recursive: true });
	if (existsSync(lockPath)) {
		try {
			const raw = await readFile(lockPath, 'utf8');
			const ts = Number.parseInt(raw.trim(), 10);
			// Stale lock if older than 30 min
			if (Date.now() - ts < 30 * 60 * 1000) return false;
		} catch {
			/* fallthrough — overwrite */
		}
	}
	await writeFile(lockPath, String(Date.now()), 'utf8');
	return true;
}

async function releaseLock(): Promise<void> {
	const lockPath = dataPath(LOCK_FILE);
	try {
		await readFile(lockPath, 'utf8');
		const fs = await import('node:fs/promises');
		await fs.unlink(lockPath);
	} catch {
		/* not there */
	}
}

interface DownloadOpts {
	/** Called whenever a new chunk arrives. */
	onProgress?: (bytes: number, total: number | null) => void;
}

async function downloadFile(
	url: string,
	dest: string,
	token: string | undefined,
	opts: DownloadOpts = {}
): Promise<void> {
	const headers: Record<string, string> = { 'User-Agent': `CloudGate/${VERSION}` };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(url, { headers, redirect: 'follow' });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

	const lenHeader = res.headers.get('content-length');
	const total = lenHeader ? Number.parseInt(lenHeader, 10) : null;
	let received = 0;
	const reporter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			received += chunk.length;
			opts.onProgress?.(received, total);
			cb(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(res.body as never), reporter, createWriteStream(dest));
}

async function sha256Of(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash('sha256').update(buf).digest('hex');
}

async function verifyGpgSignature(
	archivePath: string,
	sigPath: string
): Promise<{ verified: boolean; reason?: string }> {
	const pubKey = '/app/keys/release.pub';
	if (!existsSync(pubKey)) return { verified: false, reason: 'no public key baked in image' };
	if (!existsSync(sigPath)) return { verified: false, reason: 'no signature file in release' };

	return new Promise((resolve) => {
		const args = ['--no-default-keyring', '--keyring', '/tmp/cloudgate-keyring.gpg', '--import', pubKey];
		const imp = spawn('gpg', args);
		imp.on('close', () => {
			const verify = spawn('gpg', [
				'--no-default-keyring',
				'--keyring',
				'/tmp/cloudgate-keyring.gpg',
				'--verify',
				sigPath,
				archivePath,
			]);
			let stderr = '';
			verify.stderr.on('data', (c) => {
				stderr += c.toString();
			});
			verify.on('close', (code) => {
				if (code === 0) resolve({ verified: true });
				else resolve({ verified: false, reason: stderr.trim() || `gpg exit ${code}` });
			});
			verify.on('error', (err) => resolve({ verified: false, reason: err.message }));
		});
		imp.on('error', (err) => resolve({ verified: false, reason: err.message }));
	});
}

export async function triggerInstall(targetVersion: string): Promise<void> {
	const cfg = getConfig();

	// Reset + announce we're starting
	setStateField('started_at', new Date().toISOString());
	setStateField('target_version', targetVersion);
	setStateField('last_error', null);
	setStateField('state', 'downloading');
	setStep('acquire_lock', 1);

	if (!(await acquireLock())) {
		setStateField('state', 'failed');
		setStep('failed', 0);
		throw new Error('Another update is already in progress');
	}

	const stagingDir = dataPath(STAGING_DIR_NAME);
	await mkdir(stagingDir, { recursive: true });

	const baseUrl = `https://github.com/${cfg.CLOUDGATE_UPDATE_REPO}/releases/download/${targetVersion}`;
	const archive = `${stagingDir}/cloudgate-${targetVersion}.tar.gz`;
	const sha = `${archive}.sha256`;
	const sig = `${archive}.sig`;

	try {
		// ---- Download (heavy step) ----
		setStateField('state', 'downloading');
		setStateField('download_bytes', 0);
		setStateField('download_total', null);
		setStep('download_archive', 0);
		publish('update.installing', { version: targetVersion, step: 'download' });
		// Throttle progress events to ~5/sec so we don't spam SSE subscribers
		let lastEmit = 0;
		await downloadFile(`${baseUrl}/cloudgate-${targetVersion}.tar.gz`, archive, cfg.CLOUDGATE_GITHUB_TOKEN, {
			onProgress: (bytes, total) => {
				state = { ...state, download_bytes: bytes, download_total: total };
				const now = Date.now();
				if (now - lastEmit > 200) {
					lastEmit = now;
					const frac = total ? bytes / total : 0;
					setStep('download_archive', frac);
				}
			},
		});
		// Flush final 100% of download
		setStep('download_archive', 1);

		// Optional sidecar files — keep going if they 404
		setStep('download_sha', 0);
		try {
			await downloadFile(
				`${baseUrl}/cloudgate-${targetVersion}.tar.gz.sha256`,
				sha,
				cfg.CLOUDGATE_GITHUB_TOKEN
			);
		} catch {
			log.warn({ targetVersion }, 'No sha256 file in release — proceeding without checksum');
		}
		setStep('download_sha', 1);

		setStep('download_sig', 0);
		try {
			await downloadFile(`${baseUrl}/cloudgate-${targetVersion}.tar.gz.sig`, sig, cfg.CLOUDGATE_GITHUB_TOKEN);
		} catch {
			log.warn({ targetVersion }, 'No signature file in release — proceeding unsigned (warning)');
		}
		setStep('download_sig', 1);

		// ---- Verify ----
		setStateField('state', 'verifying');
		publish('update.installing', { version: targetVersion, step: 'verify' });
		setStep('verify_sha', 0);
		if (existsSync(sha)) {
			const expected = (await readFile(sha, 'utf8')).trim().split(/\s+/)[0];
			const actual = await sha256Of(archive);
			if (expected && actual !== expected) {
				throw new Error(`SHA256 mismatch — expected ${expected}, got ${actual}`);
			}
			log.info('SHA256 verified');
		}
		setStep('verify_sha', 1);

		setStep('verify_gpg', 0);
		const gpg = await verifyGpgSignature(archive, sig);
		if (existsSync(sig) && !gpg.verified) {
			throw new Error(`GPG verification failed: ${gpg.reason ?? 'unknown'}`);
		}
		setStep('verify_gpg', 1);

		// ---- Hand off ----
		setStateField('state', 'installing');
		setStep('spawn_apply', 0);
		publish('update.installing', { version: targetVersion, step: 'apply' });

		const applyScript = '/app/bin/apply-update.sh';
		if (!existsSync(applyScript)) {
			throw new Error('apply-update.sh not present in image — image too old to self-update');
		}
		const child = spawn(applyScript, [archive, targetVersion], {
			stdio: 'inherit',
			detached: true,
		});
		child.unref();
		setStep('spawn_apply', 1);
		setStep('apply_running', 0);

		record({ action: 'update.dispatched', meta: { target: targetVersion } });
		// We don't await — the apply script restarts the backend mid-stream.
		// Frontend will detect disconnect and switch to /api/health polling.
	} catch (err) {
		setStateField('state', 'failed');
		setStateField('last_error', (err as Error).message);
		setStep('failed', 0);
		publish('update.failed', { version: targetVersion, error: (err as Error).message });
		log.error({ err: (err as Error).message }, 'Update install failed');
		await releaseLock();
		resetProgress();
		throw err;
	}
}

// ---------------------------------------------------------------------------
// History / log helpers (consumed by routes/updates.ts)
// ---------------------------------------------------------------------------

/**
 * Read the last N lines of /data/logs/update-history.log. Used by the SPA
 * after the backend restart to "replay" the apply phase the user couldn't
 * see live.
 */
export async function readUpdateLog(maxLines = 200): Promise<{ lines: string[]; byte_offset: number }> {
	const path = dataPath('logs', 'update-history.log');
	if (!existsSync(path)) return { lines: [], byte_offset: 0 };
	try {
		const raw = await readFile(path, 'utf8');
		const all = raw.split('\n');
		// Drop the trailing empty line that comes from a final \n
		while (all.length > 0 && all[all.length - 1] === '') all.pop();
		const tail = all.slice(-Math.max(0, maxLines));
		return { lines: tail, byte_offset: Buffer.byteLength(raw, 'utf8') };
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'readUpdateLog failed');
		return { lines: [], byte_offset: 0 };
	}
}

/**
 * Read the newest .last-update-*.json marker so the SPA can determine
 * whether the most recent install succeeded / rolled back.
 */
export async function readLastUpdateMarker(): Promise<unknown | null> {
	const updatesDir = dataPath('updates');
	if (!existsSync(updatesDir)) return null;
	try {
		const fs = await import('node:fs/promises');
		const entries = await fs.readdir(updatesDir);
		const markers = entries
			.filter((e) => e.startsWith('.last-update-') && e.endsWith('.json'))
			.sort()
			.reverse();
		if (markers.length === 0) return null;
		const first = markers[0];
		if (!first) return null;
		const raw = await readFile(`${updatesDir}/${first}`, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'readLastUpdateMarker failed');
		return null;
	}
}

// -------------------------------- init -------------------------------------

let pollTimer: NodeJS.Timeout | null = null;

export async function init(): Promise<void> {
	const cfg = getConfig();
	if (cfg.CLOUDGATE_DISABLE_UPDATES) {
		log.info('Auto-updates disabled via ENV');
		return;
	}
	await loadSettings();
	// First check after 60s grace period
	setTimeout(() => void triggerCheck(), 60_000).unref();
	pollTimer = setInterval(() => void triggerCheck(), POLL_INTERVAL_MS);
	pollTimer.unref?.();
	log.info({ channel: state.channel, mode: state.mode }, 'Updater initialised');
}
