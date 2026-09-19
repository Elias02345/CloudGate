/**
 * A crash has to leave a trace where people look for it.
 *
 * Node prints an escaped exception to stderr and exits. stderr reaches
 * `docker logs` and nothing else — in particular not
 * `/data/logs/cloudgate.log`, which is the file the Recovery UI shows and the
 * one an operator opens when the container is restarting in a loop. So the
 * backend installs handlers that log the crash through pino first.
 *
 * These tests run a real child process, crash it, and read the log file back
 * off disk. The last one is the control: the same crash with no handlers
 * installed leaves the file without it, which is what the other two are worth.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(backendRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.CMD' : 'tsx');

let tmpDir: string | null = null;

afterEach(() => {
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = null;
});

/**
 * Run `body` in a child with the real logger, in production mode so the
 * rotating file target is actually engaged. Resolves with the exit code and
 * whatever ended up in /data/logs.
 */
async function crashChild(
	body: string,
	opts: { handlers?: boolean } = {}
): Promise<{ code: number | null; log: string }> {
	tmpDir = mkdtempSync(join(tmpdir(), 'cloudgate-fatal-'));
	const script = join(tmpDir, 'crash.ts');
	const loggerPath = JSON.stringify(join(backendRoot, 'src', 'logger.ts'));
	// The logger is imported either way, so the file target is set up in both
	// cases and a missing crash line means it went unlogged, not unconfigured.
	const source = [
		`import { logger, installFatalHandlers } from ${loggerPath};`,
		`logger.info('child started');`,
		opts.handlers === false ? '' : 'installFatalHandlers();',
		body,
	].join('\n');
	writeFileSync(script, source);

	const code = await new Promise<number | null>((resolve) => {
		const child = spawn(tsx, [script], {
			env: {
				...process.env,
				NODE_ENV: 'production',
				CLOUDGATE_DATA_DIR: tmpDir as string,
				LOG_LEVEL: 'info',
			},
			stdio: 'ignore',
			shell: process.platform === 'win32',
		});
		child.on('exit', resolve);
	});

	// pino-roll names the file with a rotation suffix, so read whatever landed.
	const logDir = join(tmpDir, 'logs');
	let log = '';
	try {
		for (const name of readdirSync(logDir)) {
			log += readFileSync(join(logDir, name), 'utf8');
		}
	} catch {
		/* no log directory at all — the assertions below will say so */
	}
	return { code, log };
}

describe('fatal handlers', () => {
	it('writes an uncaught exception to the log file before exiting', async () => {
		const { code, log } = await crashChild(`setTimeout(() => { throw new Error('boom-uncaught'); }, 10);`);

		expect(code).toBe(1);
		expect(log).toContain('Uncaught exception');
		// The stack matters more than the message — without it the line is noise.
		expect(log).toContain('boom-uncaught');
	}, 60_000);

	it('writes an unhandled rejection to the log file before exiting', async () => {
		const { code, log } = await crashChild(
			`setTimeout(() => { void Promise.reject(new Error('boom-rejection')); }, 10);`
		);

		expect(code).toBe(1);
		expect(log).toContain('Unhandled promise rejection');
		expect(log).toContain('boom-rejection');
	}, 60_000);

	it('without the handlers the same crash never reaches the log file', async () => {
		// The control. Node still exits non-zero and still prints to stderr —
		// it is the log file, the one the Recovery UI reads, that stays silent.
		const { code, log } = await crashChild(`setTimeout(() => { throw new Error('boom-silent'); }, 10);`, {
			handlers: false,
		});

		expect(code).not.toBe(0);
		expect(log).toContain('child started'); // the file target really was live
		expect(log).not.toContain('boom-silent');
	}, 60_000);
});
