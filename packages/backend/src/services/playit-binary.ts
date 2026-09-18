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
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from '../config.js';
import { childLogger } from '../logger.js';

const log = childLogger('playit-binary');

/**
 * The agent release this CloudGate build installs.
 *
 * Pinned to an exact tag, never `releases/latest`: a moving URL means the
 * bytes we execute can change under us, and there is nothing to check them
 * against. Upstream publishes no checksum or signature files, so the hashes
 * below were taken from the release assets of this tag and are what makes
 * the download reproducible.
 *
 * To bump: pick a release at
 *   https://github.com/playit-cloud/playit-agent/releases
 * then, for each target, `curl -fsSL <asset-url> | sha256sum` and paste the
 * results here together with the new tag.
 */
const PLAYIT_AGENT_VERSION = 'v1.0.10';
const PLAYIT_RELEASE_BASE = `https://github.com/playit-cloud/playit-agent/releases/download/${PLAYIT_AGENT_VERSION}`;

/**
 * Pinned binary metadata. Keys are `${platform}-${arch}`.
 *
 * Every entry must carry a real sha256 — an unverifiable target belongs out
 * of this table, not in it with a placeholder, because a placeholder used to
 * mean "download and run whatever arrives".
 *
 * macOS is absent on purpose: the upstream release publishes no darwin asset
 * (the URL this table used to carry 404s). A darwin host falls through to the
 * "no pinned binary" error, which tells the operator to point
 * CLOUDGATE_PLAYIT_BINARY_PATH at their own build.
 */
export const BINARIES: Record<string, { url: string; sha256: string } | undefined> = {
	'linux-x64': {
		url: `${PLAYIT_RELEASE_BASE}/playit-linux-amd64`,
		sha256: '2df7d9f10227ab312b1ad341853db4e8a8243df5cfcdbae58713a4271711c339',
	},
	'linux-arm64': {
		url: `${PLAYIT_RELEASE_BASE}/playit-linux-aarch64`,
		sha256: '4c0db3e7b3a8158e249441c2f0b73f54e83429395890c7b1ca45fd7a6303d763',
	},
	// Upstream ships both a signed and an unsigned Windows build; take the
	// signed one so the OS gets a second opinion on the bytes.
	'win32-x64': {
		url: `${PLAYIT_RELEASE_BASE}/playit-windows-x86_64-signed.exe`,
		sha256: '2dbdaad119844cbbc062cc9774b8b462afa5f1b4b7832a9fc5ef4676cae887cf',
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

	if (existsSync(target) && meta) {
		const ok = await verifyChecksum(target, meta.sha256);
		if (ok) {
			log.debug({ key, path: target }, 'playit-agent already present and checksum matches');
			return { path: target, downloaded: false };
		}
		// Could be a partial download, a tampered file, or a leftover from an
		// older pin. Either way we do not run it — replace it below.
		log.warn({ key, path: target }, 'playit-agent checksum mismatch — re-downloading');
	}

	if (!meta) {
		throw new Error(`No pinned playit-agent binary for platform ${key}. Set CLOUDGATE_PLAYIT_BINARY_PATH.`);
	}

	if (process.env.CLOUDGATE_PLAYIT_DISABLE_DOWNLOAD === 'true') {
		throw new Error(
			`playit-agent missing at ${target} and CLOUDGATE_PLAYIT_DISABLE_DOWNLOAD=true. Drop the binary in /data/playit/bin/ manually or unset the env var.`
		);
	}

	await downloadTo(meta.url, target, meta.sha256);

	log.info({ path: target, key, version: PLAYIT_AGENT_VERSION }, 'playit-agent downloaded');
	return { path: target, downloaded: true };
}

/**
 * Download, verify, and only then put the file where it will be executed.
 *
 * Order matters. Writing to `target` first and checking afterwards leaves an
 * executable of unknown provenance sitting at the path the tunnel manager
 * spawns — the previous version did exactly that, and its mismatch `throw`
 * fired only after the rename. The temp file is written without the execute
 * bit for the same reason: nothing is runnable until its hash matches.
 */
async function downloadTo(url: string, target: string, expectedSha256: string): Promise<void> {
	const tmp = `${target}.${process.pid}.download`;
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`playit-agent download failed: HTTP ${res.status} for ${url}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await writeFile(tmp, buf, { mode: 0o600 });

	const ok = await verifyChecksum(tmp, expectedSha256);
	if (!ok) {
		await unlink(tmp).catch(() => null);
		throw new Error(
			`Downloaded playit-agent sha256 mismatch — refusing to use it. Expected ${expectedSha256} from ${url}.`
		);
	}

	if (process.platform !== 'win32') {
		await chmod(tmp, 0o755);
	}
	await rename(tmp, target);
}

async function verifyChecksum(path: string, expected: string): Promise<boolean> {
	const buf = await readFile(path);
	const actual = createHash('sha256').update(buf).digest('hex');
	return actual === expected;
}
