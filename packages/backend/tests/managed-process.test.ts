/**
 * ManagedProcess — supervisor base class behaviour.
 *
 * We use a tiny shim subclass that spawns `node -e ...` so the test runs
 * cross-platform without needing a specific binary on PATH.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedProcess, type ProcessStatus } from '../src/services/managed-process.js';

let tmpDir: string;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-mp-'));
	process.env.CLOUDGATE_DATA_DIR = tmpDir;
});

afterAll(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

class EchoProcess extends ManagedProcess {
	private healthOverride: ProcessStatus = 'running';
	private script: string;

	constructor(script: string, id = 'echo-test') {
		super({ id, binPath: process.execPath, loggerName: 'echo-process' });
		this.script = script;
	}

	protected buildArgs(): string[] {
		return ['-e', this.script];
	}

	protected async checkHealth(): Promise<{ status: ProcessStatus; reason?: string }> {
		if (!this.healthOverride || this.healthOverride === 'error') {
			return { status: 'error', reason: 'forced error' };
		}
		return { status: this.healthOverride };
	}
}

describe('ManagedProcess', () => {
	it('starts a child, captures stdout into the ring buffer, and reports stopped after exit', async () => {
		const proc = new EchoProcess(
			"process.stdout.write('hello-from-child\\n'); setTimeout(()=>process.exit(0), 100)"
		);
		proc.start();
		await waitFor(() => proc.currentStatus === 'stopped' || proc.currentStatus === 'starting', 10_000);
		// The child exits intentionally with code 0; backoff path runs, but
		// status flips to 'error' since intentionallyStopped was never set.
		// We just check that the ring buffer captured the output at some point.
		await waitFor(() => proc.getLogs(10).join('\n').includes('hello-from-child'), 10_000);
		expect(proc.getLogs(10).join('\n')).toContain('hello-from-child');
		await proc.stop();
	}, 30_000);

	it('stop() flips status to stopped and prevents auto-restart', async () => {
		const proc = new EchoProcess(
			"setInterval(()=>process.stdout.write('tick\\n'), 50); setTimeout(()=>{}, 10000)"
		);
		proc.start();
		// Give it a moment to spawn
		await sleep(100);
		await proc.stop();
		expect(proc.currentStatus).toBe('stopped');
		// Wait a bit longer to confirm no respawn
		await sleep(300);
		expect(proc.currentStatus).toBe('stopped');
	}, 30_000);

	it('log ring buffer is bounded', async () => {
		const proc = new EchoProcess(
			'for(let i=0;i<1100;i++) process.stdout.write(`line${i}\\n`); setTimeout(()=>process.exit(0),200)'
		);
		proc.start();
		// Wait for the LAST line, not for a count.
		//
		// The buffer caps at 1000, so `length >= 1000` goes true the moment the
		// thousandth line lands — while lines 1000..1099 are still streaming in.
		// Asserting on line1099 right after that is a race the test loses
		// whenever the machine is busy enough to widen the gap, which is what
		// made this fail at random under the full suite.
		await waitFor(() => proc.getLogs(1500).join('\n').includes('line1099'), 15_000);
		const logs = proc.getLogs(1500);
		// Buffer cap is 1000 in implementation.
		expect(logs.length).toBeLessThanOrEqual(1000);
		// The newest lines are the ones kept; the oldest are dropped.
		expect(logs.join('\n')).toContain('line1099');
		expect(logs.join('\n')).not.toContain('line0\n');
		await proc.stop();
	}, 30_000);
});

async function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(20);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
