/**
 * Backoff-race regression — start() while a backoff respawn is queued must
 * not leak a child.
 *
 * The 0.2.1 bug: cloudflared kept crashing with "address already in use"
 * because the supervisor's pending-respawn setTimeout fired ~ms after a
 * manual start() and overwrote `this.child` with a second instance. The
 * first child kept the metrics port.
 *
 * Repro: spawn a fast-exiting child (so the exit handler queues a backoff
 * respawn), call start() before the backoff fires, then assert no third
 * spawn appears.
 *
 * On timing: this test used to sleep for fixed intervals and assume the child
 * had started and exited within 150 ms. On a loaded machine — the whole suite
 * running in parallel — spawning `node -e` can take longer than that, so the
 * manual start() hit a process that had not exited yet, did nothing, and the
 * test failed for a reason that had nothing to do with the bug it guards. It
 * now waits on conditions instead of on the clock, and the second child stays
 * alive so the assertion does not depend on how far the backoff has doubled.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ManagedProcess, type ProcessStatus } from '../src/services/managed-process.js';

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-mp-race-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
});

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Long enough that a queued 1s backoff would have fired well within it. */
const BACKOFF_OBSERVE_MS = 1500;

class CountingProcess extends ManagedProcess {
	spawnCount = 0;
	/** Spawns after this many stay alive instead of exiting immediately. */
	private readonly exitForFirst: number;

	constructor(exitForFirst: number) {
		super({ id: 'race-test', binPath: process.execPath, loggerName: 'race-test' });
		this.exitForFirst = exitForFirst;
	}

	protected override buildArgs(): string[] {
		this.spawnCount++;
		// The first N children exit right away to queue a backoff respawn;
		// later ones linger, so a third spawn can only come from the timer
		// this test is about — not from the child dying again.
		return this.spawnCount <= this.exitForFirst
			? ['-e', 'setTimeout(()=>process.exit(0), 50)']
			: ['-e', 'setTimeout(()=>{}, 60000)'];
	}

	protected override async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		return { status: 'running' };
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `predicate` holds, or fail with a message naming what we waited for. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(25);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

describe('ManagedProcess backoff race', () => {
	it('does not double-spawn when start() races a queued backoff', async () => {
		const proc = new CountingProcess(1);
		proc.start();

		// The child has to actually exit before a respawn is queued — that is
		// the state this test needs, and how long it takes is not our business.
		await waitFor(
			'first child to exit and queue a respawn',
			() => proc.spawnCount === 1 && proc.currentStatus === 'error'
		);

		// Manual start while the backoff timer is still pending.
		proc.start();
		await waitFor('manual start to spawn', () => proc.spawnCount === 2);

		// If start() failed to cancel the queued respawn, it fires in here.
		await sleep(BACKOFF_OBSERVE_MS);
		expect(proc.spawnCount).toBe(2);

		await proc.stop();
	}, 15_000);

	it('stop() cancels any pending backoff respawn', async () => {
		const proc = new CountingProcess(1);
		proc.start();
		await waitFor(
			'first child to exit and queue a respawn',
			() => proc.spawnCount === 1 && proc.currentStatus === 'error'
		);

		await proc.stop();
		await sleep(BACKOFF_OBSERVE_MS);

		expect(proc.spawnCount).toBe(1);
		expect(proc.currentStatus).toBe('stopped');
	}, 15_000);
});
