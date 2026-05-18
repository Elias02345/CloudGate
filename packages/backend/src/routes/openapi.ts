/**
 * GET /api/openapi.json — serves the OpenAPI 3.1 spec.
 *
 * Public route (no auth) so docs viewers and AI agents can fetch it
 * unauthenticated. The schemas it describes still require auth at runtime.
 */

import { Router, type Router as RouterType } from 'express';
import { buildOpenApiSpec } from '../openapi/spec.js';

export const openapiRouter: RouterType = Router();

let cached: { generatedAt: number; spec: Record<string, unknown> } | null = null;
const CACHE_TTL_MS = 60_000;

openapiRouter.get('/', (_req, res) => {
	if (!cached || Date.now() - cached.generatedAt > CACHE_TTL_MS) {
		cached = { generatedAt: Date.now(), spec: buildOpenApiSpec() };
	}
	res.json(cached.spec);
});
