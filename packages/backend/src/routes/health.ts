import { Router, type Router as RouterType } from 'express';
import { VERSION } from '../config.js';
import { getDb } from '../db/db.js';

export const healthRouter: RouterType = Router();

healthRouter.get('/', async (_req, res) => {
	let dbOk = false;
	try {
		const knex = getDb();
		await knex.raw('SELECT 1');
		dbOk = true;
	} catch {
		dbOk = false;
	}

	const status = dbOk ? 200 : 503;
	res.status(status).json({
		status: dbOk ? 'ok' : 'degraded',
		version: VERSION,
		db: dbOk,
		uptime_seconds: Math.round(process.uptime()),
		timestamp: new Date().toISOString(),
	});
});
