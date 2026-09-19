import { existsSync, mkdirSync } from 'node:fs';
import pino from 'pino';
import { dataPath, getConfig } from './config.js';

const cfg = getConfig();

/**
 * Build a pino logger with two transports in production:
 *   - stdout (for `docker logs`)
 *   - rotating file in /data/logs/cloudgate.log (kept for 7 days, 10MB each)
 *
 * In dev / test we just go to stdout for simplicity.
 */
function buildLogger(): pino.Logger {
	const inProd = cfg.NODE_ENV === 'production';
	const targets: pino.TransportTargetOptions[] = [
		{
			target: 'pino/file',
			level: cfg.LOG_LEVEL,
			options: { destination: 1 }, // stdout
		},
	];

	if (inProd) {
		const logDir = dataPath('logs');
		try {
			if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
			targets.push({
				target: 'pino-roll',
				level: cfg.LOG_LEVEL,
				options: {
					file: `${logDir}/cloudgate.log`,
					frequency: 'daily',
					size: '10M',
					limit: { count: 7 }, // keep 7 rotated files
					mkdir: true,
				},
			});
		} catch (err) {
			// Don't fail boot just because we can't open the log file.
			console.error('[logger] could not enable file rotation:', (err as Error).message);
		}
	}

	// pino's transport.targets is incompatible with custom level formatters
	// (formatters can't be serialised to worker threads). Drop the level
	// formatter and keep default numeric levels (10/20/30/40/50/60).
	return pino({
		level: cfg.LOG_LEVEL,
		timestamp: pino.stdTimeFunctions.isoTime,
		transport: { targets },
	});
}

export const logger = buildLogger();

export function childLogger(component: string): pino.Logger {
	return logger.child({ component });
}

/**
 * Log an escaped error before the process goes down.
 *
 * That it goes down is Node's default since v15 and the right call: state
 * after an uncaught exception is not worth trusting, and s6 restarts the
 * backend in a second.
 *
 * What was missing is the explanation. Node's own message goes to stderr,
 * which reaches `docker logs` and nowhere else — not
 * `/data/logs/cloudgate.log`, the file the Recovery UI shows and the one an
 * operator opens when the container is restarting in a loop. With a handler
 * installed the crash is logged like everything else, stack included, where
 * people look.
 *
 * No explicit flush before exiting: pino's transport runs on a thread-stream,
 * which registers its own `exit` hook and flushes synchronously. Checked by
 * deleting a flush call and watching the tests still find the line on disk.
 */
export function installFatalHandlers(): void {
	const die =
		(what: string) =>
		(err: unknown): void => {
			logger.fatal({ err }, what);
			process.exit(1);
		};
	process.on('uncaughtException', die('Uncaught exception — exiting'));
	process.on('unhandledRejection', die('Unhandled promise rejection — exiting'));
}
