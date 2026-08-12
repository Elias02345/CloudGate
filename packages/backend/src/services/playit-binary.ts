/**
 * Idempotent download + verify of the `playit-agent` binary.
 *
 * Lives at /data/playit/bin/playit-agent. If the file exists with a
 * matching sha256, we skip the download — boot stays fast and offline
 * setups keep working.
 *
 * Version is pinned in this file rather than user-configurable so the
 * agent + REST client always agree on supported features. Bump when
 * Playit ships a relevant change.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';

const log = childLogger('playit-binary');

/**
 * Pinned binary metadata. Keys are `${platform}-${arch}`.
 *
 * To update: pick the latest release at
 *   https://github.com/playit-cloud/playit-agent/releases
 * Copy the URL + sha256 for the target you support. The CI checksum
 * verification fails early if either drifts.
 *
 * NOTE: real URLs/checksums to be filled when activating the integration —
 * placeholders here so the offline default ("binary missing") behaves
 * gracefully and the bootstrap step doesn't crash the container.
 */
const BINARIES: Record<string, { url: string; sha256: string } | undefined> = {
	'linux-x64': {
		url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64',
		sha256: '__pin_me__',
	},
	'linux-arm64': {
		url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-aarch64',
		sha256: '__pin_me__',
	},
	'darwin-arm64': {
		url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-darwin-aarch64',
		sha256: '__pin_me__',
	},
	'win32-x64': {
		url: 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64.exe',
		sha256: '__pin_me__',
	},
};

function binaryFileName(): string {
	return process.platform === 'win32' ? 'playit-agent.exe' : 'playit-agent';
}

export function playitBinaryPath(): string {
	return dataPath('playit', 'bin', binaryFileName());
}

/**
 * Make sure /data/playit/bin/playit-agent exists and is executable.
 *
 * Honors `CLOUDGATE_PLAYIT_BINARY_PATH` for users who want to point at a
 * system-installed agent; in that case we no-op (and trust the user).
 *
 * Honors `CLOUDGATE_PLAYIT_DISABLE_DOWNLOAD=true` for air-gapped installs;
 * if the binary is missing in that mode, we fail loud and the bootstrap
 * step records the error in Recovery UI.
 */
export async function ensurePlayitBinary(): Promise<{ path: string; downloaded: boolean }> {
	if (process.env.CLOUDGATE_PLAYIT_BINARY_PATH) {
		const overridden = process.env.CLOUDGATE_PLAYIT_BINARY_PATH;
		if (!existsSync(overridden)) {
			throw new Error(`CLOUDGATE_PLAYIT_BINARY_PATH=${overridden} does not exist`);
		}
		log.info({ path: overridden }, 'Using user-supplied playit-agent binary');
		return { path: overridden, downloaded: false };
	}

	const target = playitBinaryPath();
	await mkdir(dirname(target), { recursive: true });

	const key = `${process.platform}-${process.arch}`;
	const meta = BINARIES[key];

	if (existsSync(target)) {
		if (meta && meta.sha256 !== '__pin_me__') {
			const ok = await verifyChecksum(target, meta.sha256);
			if (ok) {
				log.debug({ key, path: target }, 'playit-agent already present and checksum matches');
				return { path: target, downloaded: false };
			}
			log.warn({ key, path: target }, 'playit-agent checksum mismatch — re-downloading');
		} else {
			// Existing binary, no pin to verify against — trust it.
			return { path: target, downloaded: false };
		}
	}

	if (!meta) {
		throw new Error(`No pinned playit-agent binary for platform ${key}. Set CLOUDGATE_PLAYIT_BINARY_PATH.`);
	}

	if (process.env.CLOUDGATE_PLAYIT_DISABLE_DOWNLOAD === 'true') {
		throw new Error(
			`playit-agent missing at ${target} and CLOUDGATE_PLAYIT_DISABLE_DOWNLOAD=true. Drop the binary in /data/playit/bin/ manually or unset the env var.`
		);
	}

	await downloadTo(meta.url, target);

	if (meta.sha256 !== '__pin_me__') {
		const ok = await verifyChecksum(target, meta.sha256);
		if (!ok) {
			throw new Error(`Downloaded playit-agent sha256 mismatch — refusing to use. URL: ${meta.url}`);
		}
	}

	if (process.platform !== 'win32') {
		try {
			await chmod(target, 0o755);
		} catch {
			/* not fatal */
		}
	}
	log.info({ path: target, key }, 'playit-agent downloaded');
	return { path: target, downloaded: true };
}

async function downloadTo(url: string, target: string): Promise<void> {
	const tmp = `${target}.${process.pid}.download`;
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`playit-agent download failed: HTTP ${res.status} for ${url}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(tmp, buf, { mode: 0o755 });
	await rename(tmp, target);
}

async function verifyChecksum(path: string, expected: string): Promise<boolean> {
	const buf = await readFile(path);
	const actual = createHash('sha256').update(buf).digest('hex');
	return actual === expected;
}
