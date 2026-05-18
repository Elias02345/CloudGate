/**
 * LLM settings persistence — stored in the `settings` key/value table
 * under the `llm.*` namespace. The API key is AES-256-GCM-encrypted via
 * the existing crypto service.
 *
 * Pattern mirrors services/updater.ts settings handling.
 */

import type { LlmAutonomy, LlmProvider, LlmSettings } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { decrypt, encrypt } from './crypto.js';

interface SettingsRow {
	key: string;
	value: string;
}

const KEYS = [
	'llm.provider',
	'llm.model',
	'llm.base_url',
	'llm.api_key_encrypted',
	'llm.autonomy',
	'llm.system_prompt_override',
];

interface RawSettings {
	provider: LlmProvider | null;
	model: string | null;
	base_url: string | null;
	api_key_encrypted: string | null;
	autonomy: LlmAutonomy;
	system_prompt_override: string | null;
}

async function readRaw(): Promise<RawSettings> {
	const knex = getDb();
	const rows = await knex<SettingsRow>('settings').whereIn('key', KEYS);
	const m = new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
	return {
		provider: (m.get('llm.provider') ?? null) as LlmProvider | null,
		model: (m.get('llm.model') ?? null) as string | null,
		base_url: (m.get('llm.base_url') ?? null) as string | null,
		api_key_encrypted: (m.get('llm.api_key_encrypted') ?? null) as string | null,
		autonomy: (m.get('llm.autonomy') ?? 'off') as LlmAutonomy,
		system_prompt_override: (m.get('llm.system_prompt_override') ?? null) as string | null,
	};
}

export async function getLlmSettings(): Promise<LlmSettings> {
	const r = await readRaw();
	return {
		provider: r.provider,
		model: r.model,
		base_url: r.base_url,
		has_api_key: r.api_key_encrypted !== null,
		autonomy: r.autonomy,
		system_prompt_override: r.system_prompt_override,
	};
}

/** Returns the plaintext key, decrypting only when needed. */
export async function getLlmApiKey(): Promise<string | null> {
	const r = await readRaw();
	if (!r.api_key_encrypted) return null;
	try {
		return decrypt(r.api_key_encrypted);
	} catch {
		return null;
	}
}

interface UpdateInput {
	provider?: LlmProvider;
	model?: string;
	base_url?: string | null;
	api_key?: string | null; // null = clear, undefined = leave alone
	autonomy?: LlmAutonomy;
	system_prompt_override?: string | null;
}

export async function updateLlmSettings(input: UpdateInput): Promise<LlmSettings> {
	const knex = getDb();
	const now = new Date().toISOString();
	const writes: Array<{ key: string; value: string; updated_at: string }> = [];

	if (input.provider !== undefined) {
		writes.push({ key: 'llm.provider', value: JSON.stringify(input.provider), updated_at: now });
	}
	if (input.model !== undefined) {
		writes.push({ key: 'llm.model', value: JSON.stringify(input.model), updated_at: now });
	}
	if (input.base_url !== undefined) {
		writes.push({ key: 'llm.base_url', value: JSON.stringify(input.base_url), updated_at: now });
	}
	if (input.autonomy !== undefined) {
		writes.push({ key: 'llm.autonomy', value: JSON.stringify(input.autonomy), updated_at: now });
	}
	if (input.system_prompt_override !== undefined) {
		writes.push({
			key: 'llm.system_prompt_override',
			value: JSON.stringify(input.system_prompt_override),
			updated_at: now,
		});
	}
	if (input.api_key !== undefined) {
		// null clears, string sets
		writes.push({
			key: 'llm.api_key_encrypted',
			value: JSON.stringify(input.api_key === null ? null : encrypt(input.api_key)),
			updated_at: now,
		});
	}

	for (const w of writes) {
		await knex('settings').insert(w).onConflict('key').merge();
	}

	return getLlmSettings();
}

/**
 * Compose the system prompt sent on every conversation. Combines the
 * fixed CloudGate-context preamble with the optional user override.
 */
export function buildSystemPrompt(args: {
	hosts_count: number;
	tunnels_count: number;
	autonomy: LlmAutonomy;
	override?: string | null;
}): string {
	const base = [
		'You are CloudGate Assistant — an AI helper running inside a CloudGate self-hosted installation.',
		'CloudGate is a WebUI for Cloudflare Tunnels: users behind CGNAT route services (Immich, Nextcloud, Jellyfin, Proxmox, etc.) through Cloudflare without port-forwarding.',
		'',
		'Your tools call internal CloudGate services directly. Prefer concrete actions: list_hosts, get_health_deep, restart_tunnel, etc.',
		'',
		`Current state: ${args.hosts_count} hosts, ${args.tunnels_count} tunnels configured.`,
		`Your autonomy mode is "${args.autonomy}".`,
		'',
		'Hard rules:',
		'1. Never print secrets, tokens, API keys, or password hashes. If you see them in tool output, redact.',
		'2. Before any destructive write (delete_host, etc.), describe what will happen and ask the user to confirm — even in autonomous mode.',
		'3. Use Markdown for output. Tables for listings, code blocks for commands.',
		"4. If the user asks something requiring write tools but autonomy is \"off\" (it isn't — you're running, so it's suggest_only or autonomous), say so.",
		'5. When suggest_only mode wraps your tool call in a confirmation, the response will say `requires_user_confirmation: true`. Tell the user to click Run to proceed.',
	].join('\n');
	if (args.override?.trim()) {
		return `${base}\n\n--- User-supplied addendum ---\n${args.override.trim()}`;
	}
	return base;
}
