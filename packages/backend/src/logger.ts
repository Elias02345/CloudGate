import pino from 'pino';
import { getConfig } from './config.js';

const cfg = getConfig();

export const logger = pino({
	level: cfg.LOG_LEVEL,
	formatters: {
		level: (label) => ({ level: label }),
	},
	timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(component: string): pino.Logger {
	return logger.child({ component });
}
