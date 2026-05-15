/**
 * CloudGate backend entrypoint.
 *
 * Boot sequence:
 *   1. Load config (safe defaults if env is missing/invalid).
 *   2. Run bootstrap (idempotent — generates secrets, init DB, seed admin).
 *   3. If bootstrap fails → exit with non-zero so s6 falls through to Recovery UI.
 *   4. Start the Express server.
 */

import compression from 'compression';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { runBootstrap } from './bootstrap.js';
import { getConfig, VERSION } from './config.js';
import { closeDb } from './db/db.js';
import { childLogger, logger } from './logger.js';
import { healthRouter } from './routes/health.js';

const log = childLogger('server');

async function main(): Promise<void> {
	const cfg = getConfig();
	log.info({ version: VERSION, env: cfg.NODE_ENV }, 'CloudGate starting');

	const bootstrapStatus = await runBootstrap();
	if (!bootstrapStatus.complete) {
		log.fatal({ status: bootstrapStatus }, 'Bootstrap failed — refusing to start backend');
		process.exit(2);
	}

	const app = express();
	app.disable('x-powered-by');
	app.use(helmet({ contentSecurityPolicy: false })); // CSP set per-route once frontend is wired
	app.use(compression());
	app.use(cors({ origin: cfg.NODE_ENV === 'development' ? true : false, credentials: true }));
	app.use(express.json({ limit: '1mb' }));
	app.use(pinoHttp({ logger }));

	app.use('/api/health', healthRouter);

	app.get('/api', (_req, res) => {
		res.json({
			name: 'cloudgate',
			version: VERSION,
			docs: 'https://github.com/Elias02345/CloudGate',
		});
	});

	const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
		log.error({ err }, 'Unhandled error in request');
		res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL' });
	};
	app.use(errorHandler);

	const server = app.listen(cfg.PORT, cfg.BIND_ADDRESS, () => {
		log.info({ port: cfg.PORT, bind: cfg.BIND_ADDRESS }, 'HTTP server listening');
	});

	// Graceful shutdown
	const shutdown = async (signal: string): Promise<void> => {
		log.info({ signal }, 'Shutting down');
		server.close(() => {
			void closeDb().then(() => process.exit(0));
		});
		setTimeout(() => {
			log.warn('Forced exit after 10s');
			process.exit(1);
		}, 10_000).unref();
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
	log.fatal({ err }, 'Fatal error during startup');
	process.exit(1);
});
