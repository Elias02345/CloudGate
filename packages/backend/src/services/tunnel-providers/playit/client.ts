/**
 * Playit.gg REST API wrapper.
 *
 * Auth: Bearer token (the "API key" from playit.gg/account/api — distinct
 * from the agent secret). The user's encrypted secret_key is decoded
 * server-side; it stays out of the browser.
 *
 * NOTE: Playit's public REST surface is sparsely documented outside their
 * own dashboard. The endpoints below match what the official CLI uses;
 * tighten them once we validate against a live account during integration
 * testing. All call sites translate errors into `PlayitApiError` so the
 * route handlers can map them to clean responses.
 */

import { childLogger } from '../../../logger.js';

const log = childLogger('playit-client');

const DEFAULT_BASE_URL = 'https://api.playit.gg';
const REQUEST_TIMEOUT_MS = 15_000;

/** Free-tier defaults — surfaced in the UI quota bar. */
export const PLAYIT_FREE_TIER = { TCP: 4, UDP: 4 } as const;

export class PlayitApiError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'PlayitApiError';
		this.status = status;
		this.code = code;
	}
}

export interface PlayitCreateTunnelInput {
	name: string;
	protocol: 'tcp' | 'udp';
	local_host: string;
	local_port: number;
	/** Optional preferred port (Playit may ignore on free tier). */
	preferred_port?: number;
}

export interface PlayitCreateTunnelResult {
	tunnel_uuid: string;
	assigned_host: string;
	assigned_port: number;
	protocol: 'tcp' | 'udp';
}

export interface PlayitTunnelSummary {
	tunnel_uuid: string;
	name: string;
	protocol: 'tcp' | 'udp';
	assigned_host: string;
	assigned_port: number;
	enabled: boolean;
}

export interface PlayitAccountStatus {
	verified: boolean;
	tcp_used: number;
	udp_used: number;
}

export interface PlayitClient {
	verify(): Promise<PlayitAccountStatus>;
	listTunnels(): Promise<PlayitTunnelSummary[]>;
	createTunnel(input: PlayitCreateTunnelInput): Promise<PlayitCreateTunnelResult>;
	deleteTunnel(tunnelUuid: string): Promise<void>;
}

export function createPlayitClient(apiKey: string, baseUrl: string = DEFAULT_BASE_URL): PlayitClient {
	return {
		verify: () => request<PlayitAccountStatus>(baseUrl, apiKey, 'GET', '/account/status'),
		listTunnels: async () => {
			const data = await request<{ tunnels: PlayitTunnelSummary[] }>(
				baseUrl,
				apiKey,
				'GET',
				'/account/tunnels'
			);
			return data.tunnels ?? [];
		},
		createTunnel: (input) =>
			request<PlayitCreateTunnelResult>(baseUrl, apiKey, 'POST', '/tunnels/create', input),
		deleteTunnel: async (tunnelUuid) => {
			await request<{ ok: true }>(baseUrl, apiKey, 'POST', '/tunnels/delete', { tunnel_uuid: tunnelUuid });
		},
	};
}

async function request<T>(
	baseUrl: string,
	apiKey: string,
	method: 'GET' | 'POST',
	path: string,
	body?: unknown
): Promise<T> {
	const url = `${baseUrl}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method,
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		clearTimeout(timer);

		const text = await res.text();
		const data = text ? safeJson(text) : null;

		if (!res.ok) {
			const code = (data as { code?: string } | null)?.code ?? `HTTP_${res.status}`;
			const message =
				(data as { message?: string } | null)?.message ??
				`Playit API ${method} ${path} failed: ${res.status}`;
			log.warn({ status: res.status, code, path, method }, 'Playit API request failed');
			throw new PlayitApiError(res.status, code, message);
		}

		return data as T;
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof PlayitApiError) throw err;
		const message = (err as Error).message;
		throw new PlayitApiError(0, 'PLAYIT_NETWORK', `Playit API unreachable: ${message}`);
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
