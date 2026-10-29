/**
 * Keeps the cloudflared binary at (at least) the version this release pins.
 *
 * The in-app self-updater only swaps /app, so the cloudflared installed into
 * the image on first install would otherwise never update. We download the
 * pinned release into /data/cloudflared/bin (sacred path, updated only here),
 * SHA256-verified, and never downgrade a binary found there.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath, getConfig } from '../../../config.js';
import { childLogger } from '../../../logger.js';

const log = childLogger('cloudflared-binary');

/** Must be bumped together with ARG CLOUDFLARED_VERSION in docker/Dockerfile. */
export const CLOUDFLARED_PINNED = {
	version: '2026.10.5',
	sha256: {
		amd64: 'e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298',
		arm64: '72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d',
	},
};

const VERSION_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Parses "cloudflared version 2026.5.0 (built ...)" → "2026.5.0". */
export function parseCloudflaredVersion(output: string): string | null {
	return /cloudflared version (\d+(?:\.\d+)*)/i.exec(output)?.[1] ?? null;
}

/** Numeric per dot segment; negative, 0, positive like a - b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

function readVersion(bin: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(bin, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (err, stdout, stderr) => {
			resolve(err ? null : parseCloudflaredVersion(`${stdout}\n${stderr}`));
		});
	});
}

let cached: Promise<string> | null = null;

/** Test helper: forget the per-process cache. */
export function resetCloudflaredBinCacheForTests(): void {
	cached = null;
}

/** Resolves the cloudflared binary to spawn. Runs once per process; never throws. */
export function resolveCloudflaredBin(): Promise<string> {
	cached ??= resolve().catch((err) => {
		log.warn({ err: (err as Error).message }, 'cloudflared binary resolution failed, using PATH binary');
		return 'cloudflared';
	});
	return cached;
}

async function download(managed: string): Promise<void> {
	const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
	const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED.version}/cloudflared-linux-${arch}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`download returned HTTP ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		const actual = createHash('sha256').update(bytes).digest('hex');
		if (actual !== CLOUDFLARED_PINNED.sha256[arch]) throw new Error('SHA256 mismatch, discarding download');
		await mkdir(dirname(managed), { recursive: true });
		const tmp = `${managed}.${process.pid}.tmp`;
		await writeFile(tmp, bytes, { mode: 0o755 });
		await rename(tmp, managed);
	} finally {
		clearTimeout(timer);
	}
}

async function resolve(): Promise<string> {
	const pinned = CLOUDFLARED_PINNED.version;
	const managed = dataPath('cloudflared', 'bin', 'cloudflared');
	const [managedVer, systemVer] = await Promise.all([readVersion(managed), readVersion('cloudflared')]);
	if (managedVer && compareVersions(managedVer, pinned) >= 0) return managed;
	if (systemVer && compareVersions(systemVer, pinned) >= 0) return 'cloudflared';

	const fallback = managedVer ? managed : 'cloudflared';
	const supported = process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64');
	// No cloudflared at all (dev machine, tests): this is an update flow, not an installer.
	const from = managedVer ?? systemVer;
	if (!from || getConfig().CLOUDGATE_DISABLE_UPDATES || !supported) return fallback;

	// Only reached when the best available binary is older than the pin.
	try {
		await download(managed);
		const now = await readVersion(managed);
		if (!now) throw new Error('downloaded binary does not run');
		log.info({ from, to: now }, 'cloudflared binary updated');
		return managed;
	} catch (err) {
		log.warn(
			{ err: (err as Error).message, from, pinned },
			'cloudflared update failed, keeping current binary'
		);
		return fallback;
	}
}
