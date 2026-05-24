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
import { VERSION, getConfig } from './config.js';
import { closeDb } from './db/db.js';
import { childLogger, logger } from './logger.js';
import { looksLikeApiKey, tryApiKey } from './middleware/api-key.js';
import { apiKeyLimiter, globalLimiter } from './middleware/rate-limit.js';
import { acmeRouter } from './routes/acme.js';
import { aiRouter } from './routes/ai.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { backupRouter } from './routes/backup.js';
import { cloudflareRouter } from './routes/cloudflare.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { hostsBulkRouter } from './routes/hosts-bulk.js';
import { hostsRouter } from './routes/hosts.js';
import { openapiRouter } from './routes/openapi.js';
import { playitRouter } from './routes/playit.js';
import { restoreRouter } from './routes/restore.js';
import { totpRouter } from './routes/totp.js';
import { tunnelsRouter } from './routes/tunnels.js';
import { updatesRouter } from './routes/updates.js';
import { initRenewalCron } from './services/acme.js';
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
	// Mantine + emotion inject inline styles, so style-src needs 'unsafe-inline'.
	// Script-src stays strict (no inline JS). connect-src 'self' covers /api + SSE.
	app.use(
		helmet({
			contentSecurityPolicy: {
				useDefaults: true,
				directives: {
					defaultSrc: ["'self'"],
					scriptSrc: ["'self'"],
					styleSrc: ["'self'", "'unsafe-inline'"],
					imgSrc: ["'self'", 'data:', 'blob:'],
					fontSrc: ["'self'", 'data:'],
					connectSrc: ["'self'"],
					frameAncestors: ["'none'"],
					formAction: ["'self'"],
					baseUri: ["'self'"],
					objectSrc: ["'none'"],
				},
			},
			crossOriginEmbedderPolicy: false, // would break TOTP QR-code image rendering
		})
	);
	app.use(compression());
	// CORS: browsers (cookie/JWT path) only see the SPA's own origin.
	// API-key callers (Authorization: Bearer cgk_*) are allowed cross-origin
	// because they explicitly authenticate per-request and have no implicit
	// browser credentials.
	app.use(
		cors({
			origin: (origin, cb) => {
				if (cfg.NODE_ENV === 'development') {
					cb(null, true);
					return;
				}
				// Same-origin browser requests have no Origin header; allow.
				if (!origin) {
					cb(null, true);
					return;
				}
				// In production, only allow same-origin (cors lib treats this as
				// "echo the origin back"). Cross-origin browser requests stay
				// blocked unless a curl client sets Authorization: Bearer cgk_*.
				cb(null, origin === undefined);
			},
			credentials: true,
			allowedHeaders: ['Content-Type', 'Authorization'],
		})
	);
	// Allow API-key bearers from anywhere — overrides CORS for routes that
	// will be hit by curl / AI agents.
	app.use((req, res, next) => {
		const auth = req.header('authorization');
		if (auth && auth.toLowerCase().startsWith('bearer cgk_')) {
			res.header('Access-Control-Allow-Origin', '*');
			res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		}
		next();
	});
	app.use(pinoHttp({ logger }));

	// Restore endpoint accepts raw octet-stream (.cgbk file). Must be wired
	// BEFORE express.json so the body parser doesn't consume the stream.
	app.use('/api/restore', restoreRouter);

	app.use(express.json({ limit: '1mb' }));

	// Eager API-key auth — if Authorization: Bearer cgk_... is present, resolve
	// the user + scope BEFORE the rate limiter so the API-key tier kicks in.
	app.use('/api', async (req, _res, next) => {
		if (looksLikeApiKey(req)) {
			await tryApiKey(req);
			// silent on fail — requireAuth on the route will surface the 401
		}
		next();
	});

	app.use('/api', globalLimiter, apiKeyLimiter);

	// Global write-scope guard: read-only API keys cannot perform non-GET ops.
	app.use('/api', (req, res, next) => {
		if (
			req.apiKey?.scope === 'read' &&
			req.method !== 'GET' &&
			req.method !== 'HEAD' &&
			req.method !== 'OPTIONS'
		) {
			res.status(403).json({ error: 'API key has read-only scope', code: 'INSUFFICIENT_SCOPE' });
			return;
		}
		next();
	});

	app.use('/api/health', healthRouter);
	app.use('/api/auth', authRouter);
	app.use('/api/cloudflare', cloudflareRouter);
	app.use('/api/playit', playitRouter);
	app.use('/api/tunnels', tunnelsRouter);
	app.use('/api/hosts', hostsBulkRouter);
	app.use('/api/hosts', hostsRouter);
	app.use('/api/events', eventsRouter);
	app.use('/api/audit', auditRouter);
	app.use('/api/backup', backupRouter);
	app.use('/api/totp', totpRouter);
	app.use('/api/updates', updatesRouter);
	app.use('/api/acme', acmeRouter);
	app.use('/api/api-keys', apiKeysRouter);
	app.use('/api/openapi.json', openapiRouter);
	app.use('/api/ai', aiRouter);

	// Revive any tunnels marked as running before previous shutdown
	void initTunnelManager().catch((err) =>
		log.warn({ err: (err as Error).message }, 'Tunnel manager init failed')
	);
	void initUpdater().catch((err) => log.warn({ err: (err as Error).message }, 'Updater init failed'));
	initRenewalCron();

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
