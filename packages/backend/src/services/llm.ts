/**
 * LLM provider multiplexer.
 *
 * Speaks to Anthropic (`@anthropic-ai/sdk`) or OpenAI (`openai` SDK — also
 * works for any OpenAI-compatible base URL: OpenRouter, LMStudio, vLLM,
 * Ollama via openai-compat shim). Translates our internal tool schema
 * to each provider's native format.
 *
 * Non-streaming for v1 — the route emits the final response as JSON.
 * Adding streaming later is a route-level concern (the SDKs both expose
 * stream variants).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '@cloudgate/shared';
import OpenAI from 'openai';
import { childLogger } from '../logger.js';
import type { ToolDefinition } from './ai-tools.js';

const log = childLogger('llm');

export interface LlmMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	/** For assistant messages that requested tool calls. */
	tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	/** For tool messages — which tool call this is the result of. */
	tool_call_id?: string;
}

export interface ChatRequest {
	provider: LlmProvider;
	model: string;
	api_key: string;
	base_url?: string | null;
	system: string;
	messages: LlmMessage[];
	tools?: ToolDefinition[];
}

export interface ChatResponse {
	content: string;
	tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	/** Internal — raw provider name for debug. */
	provider: LlmProvider;
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
	log.debug({ provider: req.provider, model: req.model, tools: req.tools?.length ?? 0 }, 'LLM chat');
	if (req.provider === 'anthropic') {
		return chatAnthropic(req);
	}
	return chatOpenAi(req);
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function chatAnthropic(req: ChatRequest): Promise<ChatResponse> {
	const client = new Anthropic({ apiKey: req.api_key });
	const messages = req.messages.map((m) => {
		if (m.role === 'tool') {
			return {
				role: 'user' as const,
				content: [
					{
						type: 'tool_result' as const,
						tool_use_id: m.tool_call_id ?? '',
						content: m.content,
					},
				],
			};
		}
		if (m.role === 'assistant' && m.tool_calls?.length) {
			const blocks: Array<unknown> = [];
			if (m.content) blocks.push({ type: 'text', text: m.content });
			for (const c of m.tool_calls) {
				blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
			}
			// biome-ignore lint/suspicious/noExplicitAny: SDK union types don't accept our composite shape directly
			return { role: 'assistant' as const, content: blocks as any };
		}
		return { role: m.role as 'user' | 'assistant', content: m.content };
	});
	const tools = (req.tools ?? []).map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters as Anthropic.Tool['input_schema'],
	}));

	const r = await client.messages.create({
		model: req.model,
		max_tokens: 2048,
		system: req.system,
		// biome-ignore lint/suspicious/noExplicitAny: see above
		messages: messages as any,
		...(tools.length ? { tools } : {}),
	});

	const toolCalls: ChatResponse['tool_calls'] = [];
	let text = '';
	for (const block of r.content) {
		if (block.type === 'text') {
			text += block.text;
		} else if (block.type === 'tool_use') {
			toolCalls.push({
				id: block.id,
				name: block.name,
				args: (block.input ?? {}) as Record<string, unknown>,
			});
		}
	}
	return {
		content: text,
		...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		provider: 'anthropic',
	};
}

// ---------------------------------------------------------------------------
// OpenAI / OpenAI-compatible (works for openrouter, lmstudio, ollama, ...)
// ---------------------------------------------------------------------------

async function chatOpenAi(req: ChatRequest): Promise<ChatResponse> {
	const client = new OpenAI({
		apiKey: req.api_key,
		...(req.base_url ? { baseURL: req.base_url } : {}),
	});
	const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
	for (const m of req.messages) {
		if (m.role === 'user') {
			messages.push({ role: 'user', content: m.content });
		} else if (m.role === 'tool') {
			messages.push({ role: 'tool', tool_call_id: m.tool_call_id ?? '', content: m.content });
		} else {
			// assistant
			if (m.tool_calls?.length) {
				messages.push({
					role: 'assistant',
					content: m.content || null,
					tool_calls: m.tool_calls.map((c) => ({
						id: c.id,
						type: 'function' as const,
						function: { name: c.name, arguments: JSON.stringify(c.args) },
					})),
				});
			} else {
				messages.push({ role: 'assistant', content: m.content });
			}
		}
	}

	const tools = (req.tools ?? []).map((t) => ({
		type: 'function' as const,
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));

	const r = await client.chat.completions.create({
		model: req.model,
		messages,
		...(tools.length ? { tools } : {}),
		max_tokens: 2048,
	});

	const choice = r.choices[0];
	if (!choice) {
		return { content: '(no response from model)', provider: req.provider };
	}
	const text = choice.message.content ?? '';
	const toolCalls = (choice.message.tool_calls ?? [])
		.filter((tc) => tc.type === 'function' && tc.function)
		.map((tc) => {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.function.arguments || '{}');
			} catch {
				args = { _raw: tc.function.arguments };
			}
			return { id: tc.id, name: tc.function.name, args };
		});
	return {
		content: text,
		...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		provider: req.provider,
	};
}

/**
 * Test LLM connectivity with a tiny "respond OK" prompt.
 * Returns ok=true + latency, ok=false + error message.
 */
export async function testConnection(args: {
	provider: LlmProvider;
	model: string;
	api_key: string;
	base_url?: string | null;
}): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
	const t0 = Date.now();
	try {
		await chat({
			provider: args.provider,
			model: args.model,
			api_key: args.api_key,
			base_url: args.base_url ?? null,
			system: 'You are a connection test. Respond with the single word OK.',
			messages: [{ role: 'user', content: 'ping' }],
		});
		return { ok: true, latency_ms: Date.now() - t0 };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}
