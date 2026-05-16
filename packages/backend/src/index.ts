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
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
// pino-http exports a CJS function; the TS namespace-as-default makes it look non-callable.
// biome-ignore lint/suspicious/noExplicitAny: CJS/ESM interop with pino-http
import pinoHttpDefault from 'pino-http';
// biome-ignore lint/suspicious/noExplicitAny: see above
const pinoHttp: (opts?: any) => RequestHandler = pinoHttpDefault as any;
import { runBootstrap } from './bootstrap.js';
import { getConfig, VERSION } from './config.js';
import { closeDb } from './db/db.js';
import { childLogger, logger } from './logger.js';
import { globalLimiter } from './middleware/rate-limit.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { backupRouter } from './routes/backup.js';
import { cloudflareRouter } from './routes/cloudflare.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { hostsRouter } from './routes/hosts.js';
import { totpRouter } from './routes/totp.js';
import { tunnelsRouter } from './routes/tunnels.js';
import { updatesRouter } from './routes/updates.js';
import { verifyKeyOrSeed } from './services/crypto.js';
import { init as initTunnelManager } from './services/tunnel-manager.js';
import { init as initUpdater } from './services/updater.js';

const log = childLogger('server');

async function main(): Promise<void> {
	const cfg = getConfig();
	log.info({ version: VERSION, env: cfg.NODE_ENV }, 'CloudGate starting');

	const bootstrapStatus = await runBootstrap();
	if (!bootstrapStatus.complete) {
		log.fatal({ status: bootstrapStatus }, 'Bootstrap failed — refusing to start backend');
		process.exit(2);
	}

	// Verify encryption key is the same one used previously (or seed if first run).
	const keyCheck = await verifyKeyOrSeed();
	if (!keyCheck.ok) {
		log.fatal({ reason: keyCheck.reason }, 'Encryption key mismatch — backend refusing to start');
		process.exit(3);
	}

	const app = express();
	app.disable('x-powered-by');
	app.use(helmet({ contentSecurityPolicy: false })); // CSP set per-route once frontend is wired
	app.use(compression());
	app.use(cors({ origin: cfg.NODE_ENV === 'development' ? true : false, credentials: true }));
	app.use(express.json({ limit: '1mb' }));
	app.use(pinoHttp({ logger }));

	app.use('/api', globalLimiter);
	app.use('/api/health', healthRouter);
	app.use('/api/auth', authRouter);
	app.use('/api/cloudflare', cloudflareRouter);
	app.use('/api/tunnels', tunnelsRouter);
	app.use('/api/hosts', hostsRouter);
	app.use('/api/events', eventsRouter);
	app.use('/api/audit', auditRouter);
	app.use('/api/backup', backupRouter);
	app.use('/api/totp', totpRouter);
	app.use('/api/updates', updatesRouter);

	// Revive any tunnels marked as running before previous shutdown
	void initTunnelManager().catch((err) => log.warn({ err: (err as Error).message }, 'Tunnel manager init failed'));
	void initUpdater().catch((err) => log.warn({ err: (err as Error).message }, 'Updater init failed'));

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
