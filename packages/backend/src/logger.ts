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

	return pino({
		level: cfg.LOG_LEVEL,
		formatters: {
			level: (label) => ({ level: label }),
		},
		timestamp: pino.stdTimeFunctions.isoTime,
		transport: { targets },
	});
}

export const logger = buildLogger();

export function childLogger(component: string): pino.Logger {
	return logger.child({ component });
}
