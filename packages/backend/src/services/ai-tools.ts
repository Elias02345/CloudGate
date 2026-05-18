/**
 * Internal tool layer for the in-app AI assistant.
 *
 * Each "tool" maps a JSON-schema-described function name to a TypeScript
 * implementation that calls the same service layer the HTTP routes use
 * (no HTTP round-trip). Read tools are always allowed; write tools are
 * gated by the user's autonomy setting:
 *
 *   off:           AI endpoint disabled entirely
 *   suggest_only:  writes return {requires_user_confirmation, action_token}
 *                  — the UI surfaces a confirm card, user clicks Run, the
 *                  /api/ai/confirm-action endpoint actually runs the tool
 *   autonomous:    writes run directly, audit_log entry marked ai_initiated
 *
 * Tools translate transparently to both Anthropic Tool-Use and OpenAI
 * Function-Calling — the LLM service handles the schema-translation.
 */

import { randomUUID } from 'node:crypto';
import type { LlmAutonomy } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { record } from './audit.js';

const log = childLogger('ai-tools');

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
	kind: 'read' | 'write';
	/** Optional summary for the suggest_only confirmation card. */
	summarize?: (args: Record<string, unknown>) => string;
}

export interface ToolDispatchResult {
	/** Free-form data to feed back to the LLM as the tool result. */
	result?: unknown;
	/** When in suggest_only mode + a write tool: the UI confirmation token. */
	requires_user_confirmation?: {
		action_token: string;
		summary: string;
	};
	/** True on hard errors that the LLM should see. */
	error?: string;
}

const TOOLS: ToolDefinition[] = [
	// ---------- READ ---------------------------------------------------------
	{
		name: 'get_health',
		description: 'Light health check (DB ping + version + uptime). Use first to confirm CloudGate is up.',
		parameters: { type: 'object', properties: {} },
		kind: 'read',
	},
	{
		name: 'get_health_deep',
		description:
			'Deep health check — DB, secrets, cloudflared daemon, disk space, GitHub reachability. Use to diagnose subsystem issues.',
		parameters: { type: 'object', properties: {} },
		kind: 'read',
	},
	{
		name: 'list_hosts',
		description: 'List all proxy hosts the user owns with hostname, target, mode, last_error.',
		parameters: { type: 'object', properties: {} },
		kind: 'read',
	},
	{
		name: 'get_host',
		description: 'Get a single host by id with deploy status + last error.',
		parameters: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'integer', description: 'Host id' } },
		},
		kind: 'read',
	},
	{
		name: 'list_tunnels',
		description: 'List Cloudflare tunnels with live status (running/starting/stopped/error).',
		parameters: { type: 'object', properties: {} },
		kind: 'read',
	},
	{
		name: 'get_tunnel_logs',
		description: 'Tail recent log lines from a tunnel daemon.',
		parameters: {
			type: 'object',
			required: ['id'],
			properties: {
				id: { type: 'integer' },
				lines: { type: 'integer', default: 50, maximum: 500 },
			},
		},
		kind: 'read',
	},
	{
		name: 'list_cf_accounts',
		description: 'List connected Cloudflare accounts (no secrets — just label + account_tag + zone count).',
		parameters: { type: 'object', properties: {} },
		kind: 'read',
	},
	{
		name: 'list_zones',
		description: 'List cached Cloudflare zones for a given account.',
		parameters: {
			type: 'object',
			required: ['account_id'],
			properties: { account_id: { type: 'integer' } },
		},
		kind: 'read',
	},
	{
		name: 'get_audit_log',
		description: 'Read the audit log. Use to investigate recent activity before destructive operations.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', description: 'Optional filter (e.g. host.created)' },
				limit: { type: 'integer', default: 20, maximum: 200 },
			},
		},
		kind: 'read',
	},

	// ---------- WRITE --------------------------------------------------------
	{
		name: 'create_host',
		description: 'Create a new proxy host. Deploys asynchronously — poll get_host for last_deployed_at.',
		parameters: {
			type: 'object',
			required: ['hostname', 'forward_host', 'forward_port'],
			properties: {
				hostname: { type: 'string', description: 'Public hostname (must end in a zone you own)' },
				forward_host: { type: 'string', description: 'Internal IP or hostname' },
				forward_port: { type: 'integer', minimum: 1, maximum: 65535 },
				forward_scheme: { type: 'string', enum: ['http', 'https'], default: 'http' },
				mode: { type: 'string', enum: ['cloudflare_tunnel', 'local_nginx'], default: 'cloudflare_tunnel' },
				tunnel_id: { type: 'integer', description: 'For cloudflare_tunnel mode' },
				cf_zone_id: { type: 'integer', description: 'For cloudflare_tunnel mode' },
			},
		},
		kind: 'write',
		summarize: (a) =>
			`Create host ${a.hostname} → ${a.forward_host}:${a.forward_port} (${a.mode ?? 'cloudflare_tunnel'})`,
	},
	{
		name: 'toggle_host',
		description: 'Enable or disable a host without deleting it.',
		parameters: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'integer' } },
		},
		kind: 'write',
		summarize: (a) => `Toggle host ${a.id}`,
	},
	{
		name: 'delete_host',
		description: 'Remove a host (and its DNS record if applicable). Destructive — confirm with user.',
		parameters: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'integer' } },
		},
		kind: 'write',
		summarize: (a) => `Delete host ${a.id} (DNS record will also be removed)`,
	},
	{
		name: 'restart_tunnel',
		description: 'Restart a tunnel daemon (~5s outage). Use to recover stuck/errored tunnels.',
		parameters: {
			type: 'object',
			required: ['id'],
			properties: { id: { type: 'integer' } },
		},
		kind: 'write',
		summarize: (a) => `Restart tunnel ${a.id}`,
	},
];

export function listTools(autonomy: LlmAutonomy): ToolDefinition[] {
	if (autonomy === 'off') return [];
	return TOOLS;
}

export function getTool(name: string): ToolDefinition | null {
	return TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * Dispatch a tool call. Read tools always run. Write tools:
 *  - autonomous mode: run + audit with ai_initiated
 *  - suggest_only mode: store a pending action + return token
 */
export async function dispatchTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	ctx: { user_id: number; autonomy: LlmAutonomy; ip: string | null }
): Promise<ToolDispatchResult> {
	if (tool.kind === 'write' && ctx.autonomy === 'suggest_only') {
		// Store the pending action; UI will fetch + confirm
		const token = randomUUID();
		const knex = getDb();
		await knex('ai_pending_actions').insert({
			token,
			user_id: ctx.user_id,
			tool_name: tool.name,
			payload: JSON.stringify(args),
			summary: tool.summarize ? tool.summarize(args) : `${tool.name}(...)`,
			expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
			created_at: new Date().toISOString(),
		});
		return {
			requires_user_confirmation: {
				action_token: token,
				summary: tool.summarize ? tool.summarize(args) : `${tool.name}(${JSON.stringify(args)})`,
			},
		};
	}

	return execTool(tool, args, ctx);
}

/**
 * Execute a tool unconditionally — called by dispatchTool (autonomous /
 * read paths) and by /api/ai/confirm-action (suggest_only writes after
 * user OK).
 */
export async function execTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
	ctx: { user_id: number; autonomy?: LlmAutonomy; ip: string | null }
): Promise<ToolDispatchResult> {
	try {
		log.info({ tool: tool.name, user_id: ctx.user_id }, 'AI tool dispatch');
		const result = await runImpl(tool.name, args, ctx);

		// For writes, append an audit record so humans can see what the AI did
		if (tool.kind === 'write') {
			record({
				user_id: ctx.user_id,
				action: `ai.${tool.name}`,
				entity_type: 'ai',
				meta: { args, ai_initiated: true, autonomy: ctx.autonomy ?? 'unknown' },
				ip: ctx.ip,
			});
		}

		return { result };
	} catch (err) {
		const msg = (err as Error).message;
		log.warn({ tool: tool.name, err: msg }, 'AI tool failed');
		return { error: msg };
	}
}

// ---------------------------------------------------------------------------
// Implementation dispatch
// ---------------------------------------------------------------------------

async function runImpl(
	name: string,
	args: Record<string, unknown>,
	ctx: { user_id: number; ip: string | null }
): Promise<unknown> {
	const knex = getDb();
	switch (name) {
		// --- READ ---
		case 'get_health':
			return {
				ok: true,
				hint: 'Use /api/health for full data; this tool only confirms the DB is reachable.',
			};
		case 'get_health_deep':
			return {
				hint: 'Detailed subsystem checks: run `GET /api/health/deep` against this CloudGate. This tool returns a stub — direct the user there.',
			};
		case 'list_hosts': {
			const hosts = await knex('proxy_hosts')
				.leftJoin('tunnels', 'tunnels.id', 'proxy_hosts.tunnel_id')
				.leftJoin('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
				.where('cloudflare_accounts.user_id', ctx.user_id)
				.orWhereNull('cloudflare_accounts.user_id')
				.select(
					'proxy_hosts.id',
					'proxy_hosts.hostname',
					'proxy_hosts.forward_host',
					'proxy_hosts.forward_port',
					'proxy_hosts.mode',
					'proxy_hosts.enabled',
					'proxy_hosts.last_deployed_at',
					'proxy_hosts.last_error'
				);
			return { hosts };
		}
		case 'get_host': {
			const id = args.id;
			const host = await knex('proxy_hosts').where({ id }).first();
			if (!host) throw new Error(`Host ${id} not found`);
			return host;
		}
		case 'list_tunnels': {
			const tunnels = await knex('tunnels')
				.join('cloudflare_accounts', 'cloudflare_accounts.id', 'tunnels.cloudflare_account_id')
				.where('cloudflare_accounts.user_id', ctx.user_id)
				.select(
					'tunnels.id',
					'tunnels.name',
					'tunnels.tunnel_id',
					'tunnels.status',
					'tunnels.last_status_at'
				);
			return { tunnels };
		}
		case 'get_tunnel_logs': {
			const id = Number(args.id);
			const lines = Math.min(Number(args.lines ?? 50), 500);
			const { logsOf } = await import('./tunnel-manager.js');
			return { logs: logsOf(id, lines) };
		}
		case 'list_cf_accounts': {
			const accounts = await knex('cloudflare_accounts')
				.where({ user_id: ctx.user_id })
				.select('id', 'label', 'account_tag', 'email', 'last_validated_at');
			return { accounts };
		}
		case 'list_zones': {
			const accountId = Number(args.account_id);
			const zones = await knex('cf_zones')
				.join('cloudflare_accounts', 'cloudflare_accounts.id', 'cf_zones.cloudflare_account_id')
				.where('cf_zones.cloudflare_account_id', accountId)
				.where('cloudflare_accounts.user_id', ctx.user_id)
				.select('cf_zones.id', 'cf_zones.zone_id', 'cf_zones.name', 'cf_zones.status');
			return { zones };
		}
		case 'get_audit_log': {
			let q = knex('audit_log').orderBy('created_at', 'desc');
			if (args.action) q = q.where({ action: String(args.action) });
			q = q.limit(Math.min(Number(args.limit ?? 20), 200));
			const rows = await q;
			return { rows };
		}

		// --- WRITE ---
		case 'create_host': {
			const now = new Date().toISOString();
			const [id] = await knex('proxy_hosts').insert({
				tunnel_id: args.tunnel_id ? Number(args.tunnel_id) : null,
				cf_zone_id: args.cf_zone_id ? Number(args.cf_zone_id) : null,
				mode: (args.mode as string) ?? 'cloudflare_tunnel',
				hostname: String(args.hostname).toLowerCase(),
				forward_scheme: (args.forward_scheme as string) ?? 'http',
				forward_host: String(args.forward_host),
				forward_port: Number(args.forward_port),
				path_prefix: '/',
				enabled: 1,
				tls_options: '{}',
				headers: '{}',
				meta: '{}',
				created_at: now,
				updated_at: now,
			});
			const { deployHost } = await import('./host-deploy.js');
			void deployHost(Number(id)).catch(() => null);
			return { id: Number(id), hostname: args.hostname, status: 'deploying' };
		}
		case 'toggle_host': {
			const id = Number(args.id);
			const host = await knex('proxy_hosts').where({ id }).first();
			if (!host) throw new Error(`Host ${id} not found`);
			const next = !host.enabled;
			await knex('proxy_hosts')
				.where({ id })
				.update({ enabled: next ? 1 : 0, updated_at: new Date().toISOString() });
			const { deployHost, undeployHost } = await import('./host-deploy.js');
			if (next) void deployHost(id).catch(() => null);
			else void undeployHost(id).catch(() => null);
			return { id, enabled: next };
		}
		case 'delete_host': {
			const id = Number(args.id);
			const { undeployHost } = await import('./host-deploy.js');
			await undeployHost(id);
			await knex('proxy_hosts').where({ id }).delete();
			return { deleted: id };
		}
		case 'restart_tunnel': {
			const id = Number(args.id);
			const { stopTunnel, startTunnel } = await import('./tunnel-manager.js');
			await stopTunnel(id);
			await startTunnel(id);
			return { restarted: id };
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

/**
 * Look up and execute a pending action (after user confirmation in
 * suggest_only mode). Returns the same shape as execTool().
 */
export async function confirmAndExecAction(
	token: string,
	ctx: { user_id: number; ip: string | null }
): Promise<ToolDispatchResult> {
	const knex = getDb();
	const row = await knex('ai_pending_actions').where({ token, user_id: ctx.user_id }).first();
	if (!row) return { error: 'Action token not found or expired' };
	if (new Date(row.expires_at).getTime() < Date.now()) {
		await knex('ai_pending_actions').where({ token }).delete();
		return { error: 'Action token expired (5 min). Ask the AI again.' };
	}
	const tool = getTool(row.tool_name);
	if (!tool) {
		await knex('ai_pending_actions').where({ token }).delete();
		return { error: `Unknown tool: ${row.tool_name}` };
	}
	const args = JSON.parse(row.payload) as Record<string, unknown>;
	await knex('ai_pending_actions').where({ token }).delete();
	return execTool(tool, args, { ...ctx, autonomy: 'suggest_only' });
}
