/**
 * /api/ai — optional in-app AI assistant.
 *
 *   GET    /api/ai/settings       — read current LLM config (no plaintext key)
 *   POST   /api/ai/settings       — update config (incl. encrypted API key)
 *   POST   /api/ai/settings/test  — ping the configured LLM
 *   POST   /api/ai/chat           — send a message, get a reply (non-streaming)
 *   GET    /api/ai/conversations  — list user's threads
 *   GET    /api/ai/conversations/:id — fetch messages for one thread
 *   DELETE /api/ai/conversations/:id — soft-delete (cascade-delete messages)
 *   POST   /api/ai/confirm-action — execute a pending tool call (suggest_only)
 *
 * All endpoints require browser JWT — API-key callers are blocked because
 * the AI assistant is a UI feature with user-side confirmation. Anyway,
 * an AI agent would just use the shell API directly, not the chat.
 */

import { randomUUID } from 'node:crypto';
import {
	AiConfirmActionRequestSchema,
	AiSendMessageRequestSchema,
	AiTestRequestSchema,
	UpdateLlmSettingsRequestSchema,
} from '@cloudgate/shared';
import { Router, type Router as RouterType } from 'express';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { requireAuth, requirePasswordSet } from '../middleware/auth.js';
import { confirmAndExecAction, dispatchTool, getTool, listTools } from '../services/ai-tools.js';
import { record } from '../services/audit.js';
import {
	buildSystemPrompt,
	getLlmApiKey,
	getLlmSettings,
	updateLlmSettings,
} from '../services/llm-settings.js';
import { type LlmMessage, chat, testConnection } from '../services/llm.js';

const log = childLogger('routes:ai');
export const aiRouter: RouterType = Router();

// Block API-key callers — AI assistant is a browser UI feature, not an API
// for agents (agents should use the shell API directly). The `apiKey`
// property on the Request is set by the M7 api-key middleware; if M7 isn't
// merged yet this check is a no-op and the eager-auth gate still works.
function blockApiKeyCaller(): import('express').RequestHandler {
	return (req, res, next) => {
		// biome-ignore lint/suspicious/noExplicitAny: req.apiKey is defined by M7's type augmentation
		if ((req as any).apiKey) {
			res.status(403).json({
				error: 'AI assistant requires a browser session — agents should use the shell API directly',
				code: 'BROWSER_ONLY',
			});
			return;
		}
		next();
	};
}

aiRouter.use(requireAuth, requirePasswordSet, blockApiKeyCaller());

// ---------------------------------------------------------------------------
// GET /api/ai/settings
// ---------------------------------------------------------------------------
aiRouter.get('/settings', async (_req, res) => {
	res.json(await getLlmSettings());
});

// ---------------------------------------------------------------------------
// POST /api/ai/settings
// ---------------------------------------------------------------------------
aiRouter.post('/settings', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = UpdateLlmSettingsRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST', details: parsed.error.flatten() });
		return;
	}
	const updated = await updateLlmSettings(parsed.data);
	record({
		user_id: req.user.id,
		action: 'ai.settings_updated',
		meta: { changed: Object.keys(parsed.data).filter((k) => k !== 'api_key') },
		ip: req.ip ?? null,
	});
	res.json(updated);
});

// ---------------------------------------------------------------------------
// POST /api/ai/settings/test
// ---------------------------------------------------------------------------
aiRouter.post('/settings/test', async (req, res) => {
	const parsed = AiTestRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST' });
		return;
	}
	const current = await getLlmSettings();
	const provider = parsed.data.provider ?? current.provider;
	const model = parsed.data.model ?? current.model ?? 'claude-sonnet-4-6';
	const apiKey = parsed.data.api_key ?? (await getLlmApiKey());
	const baseUrl = parsed.data.base_url !== undefined ? parsed.data.base_url : current.base_url;
	if (!provider || !apiKey) {
		res.status(400).json({ error: 'Provider + API key required', code: 'BAD_REQUEST' });
		return;
	}
	const result = await testConnection({ provider, model, api_key: apiKey, base_url: baseUrl });
	res.json({ ...result, model });
});

// ---------------------------------------------------------------------------
// GET /api/ai/conversations
// ---------------------------------------------------------------------------
aiRouter.get('/conversations', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const knex = getDb();
	const conversations = await knex('ai_conversations')
		.where({ user_id: req.user.id })
		.orderBy('updated_at', 'desc')
		.limit(50);
	res.json({ conversations });
});

// ---------------------------------------------------------------------------
// GET /api/ai/conversations/:id
// ---------------------------------------------------------------------------
aiRouter.get('/conversations/:id', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = String(req.params.id ?? '');
	const knex = getDb();
	const conv = await knex('ai_conversations').where({ id, user_id: req.user.id }).first();
	if (!conv) {
		res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
		return;
	}
	const messages = await knex('ai_messages').where({ conversation_id: id }).orderBy('id', 'asc');
	res.json({
		conversation: conv,
		messages: messages.map(
			(m: { tool_calls: string | null; tool_results: string | null } & Record<string, unknown>) => ({
				...m,
				tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
				tool_results: m.tool_results ? JSON.parse(m.tool_results) : null,
			})
		),
	});
});

// ---------------------------------------------------------------------------
// DELETE /api/ai/conversations/:id
// ---------------------------------------------------------------------------
aiRouter.delete('/conversations/:id', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const id = String(req.params.id ?? '');
	const knex = getDb();
	const deleted = await knex('ai_conversations').where({ id, user_id: req.user.id }).delete();
	if (!deleted) {
		res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
		return;
	}
	res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat
// ---------------------------------------------------------------------------
aiRouter.post('/chat', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = AiSendMessageRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST' });
		return;
	}

	const settings = await getLlmSettings();
	if (settings.autonomy === 'off') {
		res.status(503).json({ error: 'AI assistant is disabled', code: 'AI_DISABLED' });
		return;
	}
	if (!settings.provider || !settings.model || !settings.has_api_key) {
		res.status(400).json({
			error: 'LLM not configured — set provider, model and API key in Settings → AI',
			code: 'AI_NOT_CONFIGURED',
		});
		return;
	}
	const apiKey = await getLlmApiKey();
	if (!apiKey) {
		res.status(400).json({ error: 'API key missing or unreadable', code: 'AI_NOT_CONFIGURED' });
		return;
	}

	const knex = getDb();
	const now = new Date().toISOString();

	// Resolve / create conversation
	let conversationId = parsed.data.conversation_id;
	if (!conversationId) {
		conversationId = randomUUID();
		await knex('ai_conversations').insert({
			id: conversationId,
			user_id: req.user.id,
			title: parsed.data.message.slice(0, 60),
			created_at: now,
			updated_at: now,
		});
	} else {
		const conv = await knex('ai_conversations').where({ id: conversationId, user_id: req.user.id }).first();
		if (!conv) {
			res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
			return;
		}
	}

	// Append user message
	await knex('ai_messages').insert({
		conversation_id: conversationId,
		role: 'user',
		content: parsed.data.message,
		created_at: now,
	});

	// Build the message history for the LLM (last 30 messages max)
	const rows = await knex('ai_messages')
		.where({ conversation_id: conversationId })
		.orderBy('id', 'asc')
		.limit(30);
	const llmMessages: LlmMessage[] = rows.map((r: Record<string, unknown>) => ({
		role: r.role as LlmMessage['role'],
		content: (r.content as string) ?? '',
		...(r.tool_calls
			? {
					tool_calls: JSON.parse(r.tool_calls as string) as LlmMessage['tool_calls'],
				}
			: {}),
		...(r.tool_call_id ? { tool_call_id: r.tool_call_id as string } : {}),
	}));

	// Build context for system prompt
	const hostsCount = (await knex('proxy_hosts').count<{ c: number }[]>('id as c'))[0]?.c ?? 0;
	const tunnelsCount = (await knex('tunnels').count<{ c: number }[]>('id as c'))[0]?.c ?? 0;
	const system = buildSystemPrompt({
		hosts_count: Number(hostsCount),
		tunnels_count: Number(tunnelsCount),
		autonomy: settings.autonomy,
		override: settings.system_prompt_override,
	});

	const tools = listTools(settings.autonomy);

	// First LLM call
	let response;
	try {
		response = await chat({
			provider: settings.provider,
			model: settings.model,
			api_key: apiKey,
			base_url: settings.base_url,
			system,
			messages: llmMessages,
			tools,
		});
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'LLM call failed');
		res.status(502).json({
			error: `LLM call failed: ${(err as Error).message}`,
			code: 'LLM_FAILED',
		});
		return;
	}

	// If the model wants tool calls, dispatch them and do one more round.
	// (We cap at one tool-use round per user message to keep response time
	// bounded. The user can ask again for more.)
	const toolResults: Array<{ tool_call_id: string; name: string; result: unknown; pending?: unknown }> = [];
	if (response.tool_calls?.length) {
		// Persist the assistant turn with its tool calls
		await knex('ai_messages').insert({
			conversation_id: conversationId,
			role: 'assistant',
			content: response.content || null,
			tool_calls: JSON.stringify(response.tool_calls),
			created_at: new Date().toISOString(),
		});

		// Dispatch each tool call
		for (const call of response.tool_calls) {
			const tool = getTool(call.name);
			if (!tool) {
				toolResults.push({
					tool_call_id: call.id,
					name: call.name,
					result: { error: `Unknown tool: ${call.name}` },
				});
				continue;
			}
			const dispatch = await dispatchTool(tool, call.args, {
				user_id: req.user.id,
				autonomy: settings.autonomy,
				ip: req.ip ?? null,
			});
			toolResults.push({
				tool_call_id: call.id,
				name: call.name,
				result: dispatch.result ?? dispatch.error ?? null,
				...(dispatch.requires_user_confirmation ? { pending: dispatch.requires_user_confirmation } : {}),
			});
		}

		// Persist tool results as message rows
		for (const r of toolResults) {
			await knex('ai_messages').insert({
				conversation_id: conversationId,
				role: 'tool',
				content: JSON.stringify(r.result),
				tool_results: JSON.stringify([r]),
				created_at: new Date().toISOString(),
			});
		}

		// Build new messages with results + ask the model to summarise
		const followupMessages: LlmMessage[] = [
			...llmMessages,
			{
				role: 'assistant',
				content: response.content,
				tool_calls: response.tool_calls,
			},
			...toolResults.map((r) => ({
				role: 'tool' as const,
				content: JSON.stringify(r.pending ?? r.result),
				tool_call_id: r.tool_call_id,
			})),
		];
		try {
			const finalResp = await chat({
				provider: settings.provider,
				model: settings.model,
				api_key: apiKey,
				base_url: settings.base_url,
				system,
				messages: followupMessages,
				// Don't pass tools on the second round — we want a final answer
			});
			await knex('ai_messages').insert({
				conversation_id: conversationId,
				role: 'assistant',
				content: finalResp.content,
				created_at: new Date().toISOString(),
			});
			response = finalResp;
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'LLM follow-up call failed');
		}
	} else {
		// Plain text response — persist + return
		await knex('ai_messages').insert({
			conversation_id: conversationId,
			role: 'assistant',
			content: response.content,
			created_at: new Date().toISOString(),
		});
	}

	await knex('ai_conversations')
		.where({ id: conversationId })
		.update({ updated_at: new Date().toISOString() });

	res.json({
		conversation_id: conversationId,
		message: response.content,
		tool_results: toolResults.length ? toolResults : undefined,
	});
});

// ---------------------------------------------------------------------------
// POST /api/ai/confirm-action
// ---------------------------------------------------------------------------
aiRouter.post('/confirm-action', async (req, res) => {
	if (!req.user) {
		res.status(500).json({ error: 'User missing', code: 'INTERNAL' });
		return;
	}
	const parsed = AiConfirmActionRequestSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ error: 'Invalid payload', code: 'BAD_REQUEST' });
		return;
	}
	const result = await confirmAndExecAction(parsed.data.action_token, {
		user_id: req.user.id,
		ip: req.ip ?? null,
	});
	if (result.error) {
		res.status(400).json({ error: result.error, code: 'ACTION_FAILED' });
		return;
	}
	res.json({ ok: true, result: result.result });
});
