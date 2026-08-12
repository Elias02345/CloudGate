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
 * respawn), call start() before the backoff fires, then assert only ONE
 * spawn happened.
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
	/* noop — child processes self-clean since they exit immediately */
});

class CountingProcess extends ManagedProcess {
	spawnCount = 0;
	private exitImmediately: boolean;
	private script: string;

	constructor(script: string, exitImmediately = true) {
		super({ id: 'race-test', binPath: process.execPath, loggerName: 'race-test' });
		this.script = script;
		this.exitImmediately = exitImmediately;
	}

	protected override buildArgs(): string[] {
		this.spawnCount++;
		return ['-e', this.script];
	}

	protected override async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		return this.exitImmediately ? { status: 'error', reason: 'forced' } : { status: 'running' };
	}
}

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ManagedProcess backoff race', () => {
	it('does not double-spawn when start() races a queued backoff', async () => {
		// Child exits in 50ms — short enough that we can race the backoff
		// timer with a manual start(). Backoff starts at 1s so we have a
		// ~950ms window.
		const proc = new CountingProcess('setTimeout(()=>process.exit(0), 50)');
		proc.start();

		// Wait until the child has exited and a respawn is pending.
		await sleep(150);
		expect(proc.spawnCount).toBe(1);
		expect(proc.currentStatus).not.toBe('running');

		// Trigger a manual start while the 1s backoff is still pending.
		proc.start();
		// Give the manual spawn a moment to launch, plus enough wall time
		// for the queued backoff timer to fire if it weren't cancelled.
		await sleep(1500);

		// Two spawns are expected: the initial + the manual. NOT three —
		// the queued backoff must have been cancelled by start().
		expect(proc.spawnCount).toBe(2);
		await proc.stop();
	}, 8_000);

	it('stop() cancels any pending backoff respawn', async () => {
		const proc = new CountingProcess('setTimeout(()=>process.exit(0), 50)');
		proc.start();
		await sleep(150);
		expect(proc.spawnCount).toBe(1);

		// stop() must clear the pending respawn so no extra spawn fires.
		await proc.stop();
		await sleep(1500);
		expect(proc.spawnCount).toBe(1);
		expect(proc.currentStatus).toBe('stopped');
	}, 8_000);
});

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
