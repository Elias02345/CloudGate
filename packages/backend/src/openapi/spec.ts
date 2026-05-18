/**
 * OpenAPI 3.1 specification for the CloudGate Shell API.
 *
 * Hand-curated rather than auto-generated from Zod — we'd rather keep the
 * doc readable for AI agents than have machine-precise schemas that lose
 * narrative context. The Zod schemas are the source of truth at runtime;
 * this file is the source of truth for documentation.
 *
 * Served at GET /api/openapi.json and rendered via Swagger UI in the
 * frontend at /api-docs.
 */

import { VERSION } from '../config.js';

export function buildOpenApiSpec(): Record<string, unknown> {
	return {
		openapi: '3.1.0',
		info: {
			title: 'CloudGate Shell API',
			version: VERSION,
			description: [
				'Long-lived REST API for shell / AI-agent control of a running CloudGate',
				'instance. Authenticate with `Authorization: Bearer cgk_<prefix>_<secret>`',
				'(create keys in the WebUI under Settings → API keys).',
				'',
				'See `docs/AGENT.md` in the source repo for narrative recipes and',
				'safe-by-default workflows for AI agents.',
			].join('\n'),
			license: { name: 'MIT', url: 'https://github.com/Elias02345/CloudGate/blob/main/LICENSE' },
			contact: { url: 'https://github.com/Elias02345/CloudGate' },
		},
		servers: [{ url: '/', description: 'Same-origin (when called from the same host)' }],
		components: {
			securitySchemes: {
				ApiKeyAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'CloudGate API key — cgk_<prefix>_<secret>',
				},
				JwtAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'JWT (used by the browser SPA)',
				},
			},
			schemas: {
				ErrorResponse: {
					type: 'object',
					required: ['error', 'code'],
					properties: {
						error: { type: 'string', description: 'Human-readable error message.' },
						code: {
							type: 'string',
							description: 'Stable machine-readable code — match against this, not the message.',
							examples: ['UNAUTHENTICATED', 'INVALID_API_KEY', 'INSUFFICIENT_SCOPE', 'RATE_LIMITED'],
						},
						details: { description: 'Optional Zod validation error details.' },
					},
				},
				Health: {
					type: 'object',
					properties: {
						status: { type: 'string', enum: ['ok', 'degraded'] },
						version: { type: 'string' },
						db: { type: 'boolean' },
						uptime_seconds: { type: 'integer' },
						timestamp: { type: 'string', format: 'date-time' },
					},
				},
				ProxyHost: {
					type: 'object',
					properties: {
						id: { type: 'integer' },
						hostname: { type: 'string', examples: ['immich.example.com'] },
						forward_scheme: { type: 'string', enum: ['http', 'https'] },
						forward_host: { type: 'string', examples: ['192.168.1.10'] },
						forward_port: { type: 'integer', minimum: 1, maximum: 65535 },
						mode: { type: 'string', enum: ['cloudflare_tunnel', 'local_nginx'] },
						enabled: { type: 'boolean' },
						tunnel_id: { type: 'integer', nullable: true },
						cf_zone_id: { type: 'integer', nullable: true },
						last_deployed_at: { type: 'string', format: 'date-time', nullable: true },
						last_error: { type: 'string', nullable: true },
					},
				},
				CreateProxyHostRequest: {
					type: 'object',
					required: ['hostname', 'forward_host', 'forward_port'],
					properties: {
						hostname: { type: 'string' },
						forward_scheme: { type: 'string', enum: ['http', 'https'], default: 'http' },
						forward_host: { type: 'string' },
						forward_port: { type: 'integer', minimum: 1, maximum: 65535 },
						mode: {
							type: 'string',
							enum: ['cloudflare_tunnel', 'local_nginx'],
							default: 'cloudflare_tunnel',
						},
						tunnel_id: { type: 'integer', nullable: true },
						cf_zone_id: { type: 'integer', nullable: true },
					},
				},
				Tunnel: {
					type: 'object',
					properties: {
						id: { type: 'integer' },
						name: { type: 'string' },
						tunnel_id: { type: 'string' },
						live_status: { type: 'string', enum: ['starting', 'running', 'stopped', 'error'] },
						last_status_at: { type: 'string', nullable: true },
					},
				},
				ApiKey: {
					type: 'object',
					properties: {
						id: { type: 'integer' },
						name: { type: 'string' },
						prefix: { type: 'string', examples: ['cgk_a3f9b201'] },
						scope: { type: 'string', enum: ['read', 'admin'] },
						last_used_at: { type: 'string', format: 'date-time', nullable: true },
						last_used_ip: { type: 'string', nullable: true },
						expires_at: { type: 'string', format: 'date-time', nullable: true },
						created_at: { type: 'string', format: 'date-time' },
					},
				},
			},
			responses: {
				Unauthorized: {
					description: 'No / invalid credentials',
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
				},
				Forbidden: {
					description: 'Authenticated but insufficient scope (e.g. read-only key on a write)',
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
				},
				NotFound: {
					description: 'Resource not found',
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
				},
				RateLimited: {
					description: 'Too many requests',
					content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
				},
			},
		},
		security: [{ ApiKeyAuth: [] }, { JwtAuth: [] }],
		tags: [
			{ name: 'health', description: 'Liveness + deep subsystem checks (auth not required for /).' },
			{ name: 'auth', description: 'Browser auth — JWT login + profile. Most agents use API keys instead.' },
			{ name: 'hosts', description: 'Proxy hosts (one DNS hostname → one local service).' },
			{ name: 'tunnels', description: 'Cloudflare Tunnel daemons.' },
			{ name: 'cloudflare', description: 'Cloudflare account/zone management.' },
			{ name: 'audit', description: 'Audit log (all write actions).' },
			{ name: 'updates', description: 'Self-update status + manual trigger.' },
			{ name: 'api-keys', description: 'Manage long-lived API keys (browser-only).' },
		],
		paths: {
			'/api/health': {
				get: {
					tags: ['health'],
					summary: 'Light healthcheck',
					security: [],
					responses: {
						'200': {
							description: 'Backend healthy',
							content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
						},
						'503': { description: 'Backend not healthy (eg DB unreachable)' },
					},
				},
			},
			'/api/health/deep': {
				get: {
					tags: ['health'],
					summary: 'Deep subsystem healthcheck',
					description:
						'Pings DB, secrets, cloudflared daemon, disk space, GitHub. Always 200 — inspect `checks` for details.',
					security: [],
					responses: { '200': { description: 'Subsystem status' } },
				},
			},
			'/api/hosts': {
				get: {
					tags: ['hosts'],
					summary: 'List all hosts',
					responses: {
						'200': {
							description: 'OK',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: {
											hosts: { type: 'array', items: { $ref: '#/components/schemas/ProxyHost' } },
										},
									},
								},
							},
						},
						'401': { $ref: '#/components/responses/Unauthorized' },
					},
				},
				post: {
					tags: ['hosts'],
					summary: 'Create a host (deploys async — listen for SSE host.deployed)',
					requestBody: {
						required: true,
						content: {
							'application/json': { schema: { $ref: '#/components/schemas/CreateProxyHostRequest' } },
						},
					},
					responses: {
						'201': {
							description: 'Host created (deploy is async — poll GET /api/hosts/:id for last_deployed_at)',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: { host: { $ref: '#/components/schemas/ProxyHost' } },
									},
								},
							},
						},
						'400': {
							description: 'Validation error',
							content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
						},
						'403': { $ref: '#/components/responses/Forbidden' },
					},
				},
			},
			'/api/hosts/{id}': {
				parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
				get: {
					tags: ['hosts'],
					summary: 'Get a single host',
					responses: {
						'200': {
							description: 'OK',
							content: { 'application/json': { schema: { $ref: '#/components/schemas/ProxyHost' } } },
						},
						'404': { $ref: '#/components/responses/NotFound' },
					},
				},
				put: {
					tags: ['hosts'],
					summary: 'Update a host (re-deploys)',
					responses: {
						'200': { description: 'Updated' },
						'404': { $ref: '#/components/responses/NotFound' },
					},
				},
				delete: {
					tags: ['hosts'],
					summary: 'Delete + undeploy a host',
					responses: {
						'200': { description: 'Deleted' },
						'404': { $ref: '#/components/responses/NotFound' },
					},
				},
			},
			'/api/hosts/{id}/toggle': {
				parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
				post: {
					tags: ['hosts'],
					summary: 'Toggle enabled state',
					responses: { '200': { description: 'Toggled' } },
				},
			},
			'/api/tunnels': {
				get: { tags: ['tunnels'], summary: 'List tunnels', responses: { '200': { description: 'OK' } } },
				post: {
					tags: ['tunnels'],
					summary: 'Create + start a tunnel',
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['cloudflare_account_id', 'name'],
									properties: {
										cloudflare_account_id: { type: 'integer' },
										name: { type: 'string', pattern: '^[a-zA-Z0-9-_]+$' },
									},
								},
							},
						},
					},
					responses: { '201': { description: 'Created' } },
				},
			},
			'/api/tunnels/{id}': {
				parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
				delete: {
					tags: ['tunnels'],
					summary: 'Stop + delete tunnel',
					responses: { '200': { description: 'Deleted' } },
				},
			},
			'/api/tunnels/{id}/restart': {
				parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
				post: {
					tags: ['tunnels'],
					summary: 'Restart tunnel',
					responses: { '200': { description: 'Restart triggered' } },
				},
			},
			'/api/cloudflare/accounts': {
				get: {
					tags: ['cloudflare'],
					summary: 'List CF accounts',
					responses: { '200': { description: 'OK' } },
				},
				post: {
					tags: ['cloudflare'],
					summary: 'Add a CF account by API token',
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['label', 'api_token'],
									properties: { label: { type: 'string' }, api_token: { type: 'string' } },
								},
							},
						},
					},
					responses: { '201': { description: 'Validated + stored' } },
				},
			},
			'/api/audit': {
				get: {
					tags: ['audit'],
					summary: 'List audit events (paginated)',
					parameters: [
						{ name: 'action', in: 'query', schema: { type: 'string' } },
						{ name: 'user_id', in: 'query', schema: { type: 'integer' } },
						{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
						{ name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
					],
					responses: { '200': { description: 'OK' } },
				},
			},
			'/api/updates': {
				get: {
					tags: ['updates'],
					summary: 'Current updater status',
					responses: { '200': { description: 'OK' } },
				},
			},
			'/api/api-keys': {
				get: {
					tags: ['api-keys'],
					summary: 'List your API keys (browser session only)',
					responses: {
						'200': {
							description: 'OK',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										properties: { keys: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } } },
									},
								},
							},
						},
						'403': { $ref: '#/components/responses/Forbidden' },
					},
				},
				post: {
					tags: ['api-keys'],
					summary: 'Issue a new API key (browser only — plaintext returned ONCE)',
					responses: { '201': { description: 'Created — full key in response.plaintext, save it' } },
				},
			},
		},
	};
}
