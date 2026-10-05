/**
 * Playit.gg API wrapper.
 *
 * Mirrors the official agent's api_client (playit-cloud/playit-agent,
 * packages/api_client/src/api.rs at the pinned agent tag): every call is a
 * POST with a JSON body, authenticated with `Authorization: Agent-Key <secret>`,
 * and answered with an envelope `{ status: 'success' | 'fail' | 'error', data }`.
 *
 * The agent secret comes either from the claim flow (`claimSetup` +
 * `claimExchange`, the same flow `playit claim` uses) or is pasted by the
 * user. It is decrypted server-side only and never reaches the browser.
 */

import { childLogger } from '../../../logger.js';

const log = childLogger('playit-client');

const DEFAULT_BASE_URL = 'https://api.playit.gg';
const REQUEST_TIMEOUT_MS = 15_000;

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

/** Playit tunnel types we create. Everything else is a plain tcp/udp tunnel. */
export type PlayitTunnelType = 'minecraft-java' | 'minecraft-bedrock';

export interface PlayitCreateTunnelInput {
	name: string;
	tunnel_type: PlayitTunnelType | null;
	port_type: 'tcp' | 'udp';
	agent_id: string;
	local_ip: string;
	local_port: number;
}

export interface PlayitAllocation {
	/** Address players use, e.g. `name.joinmc.link` or `x.gl.joinmc.link`. */
	assigned_domain: string;
	/** Hostname that resolves to the tunnel IP (an SRV target must be one). */
	ip_hostname: string;
	port_start: number;
}

export interface PlayitTunnel {
	id: string;
	name: string | null;
	tunnel_type: string | null;
	port_type: 'tcp' | 'udp' | 'both';
	/** null while playit is still assigning a public address. */
	allocation: PlayitAllocation | null;
	/** Why playit does not serve the tunnel (e.g. 'requires-premium'), if it says. */
	disabled_reason: string | null;
	local_ip: string | null;
	local_port: number | null;
}

export interface PlayitPortUsage {
	allowed: number;
	claimed: number;
}

export interface PlayitTunnelList {
	tunnels: PlayitTunnel[];
	tcp: PlayitPortUsage;
	udp: PlayitPortUsage;
}

export interface PlayitRunData {
	agent_id: string;
	/** 'ready', 'guest', 'email-not-verified', 'agent-over-limit', … */
	account_status: string;
}

export type PlayitClaimState = 'WaitingForUserVisit' | 'WaitingForUser' | 'UserAccepted' | 'UserRejected';

export interface PlayitClient {
	runData(): Promise<PlayitRunData>;
	listTunnels(tunnelId?: string): Promise<PlayitTunnelList>;
	createTunnel(input: PlayitCreateTunnelInput): Promise<string>;
	deleteTunnel(tunnelId: string): Promise<void>;
}

interface RawAccountTunnel {
	id: string;
	name: string | null;
	tunnel_type: string | null;
	port_type: 'tcp' | 'udp' | 'both';
	alloc: {
		status: 'pending' | 'disabled' | 'allocated';
		data?: { assigned_domain: string; ip_hostname: string; port_start: number };
	};
	origin: { type: string; data?: { local_ip?: string; local_port?: number | null } } | null;
	disabled_reason: string | null;
}

export function createPlayitClient(secretKey: string, baseUrl: string = DEFAULT_BASE_URL): PlayitClient {
	const auth = `Agent-Key ${secretKey.trim()}`;
	return {
		runData: () => call<PlayitRunData>(baseUrl, '/agents/rundata', {}, auth),
		listTunnels: async (tunnelId) => {
			const data = await call<{
				tunnels: RawAccountTunnel[];
				tcp_alloc: PlayitPortUsage;
				udp_alloc: PlayitPortUsage;
			}>(baseUrl, '/tunnels/list', { tunnel_id: tunnelId ?? null, agent_id: null }, auth);
			return {
				tunnels: data.tunnels.map(toTunnel),
				tcp: { allowed: data.tcp_alloc.allowed, claimed: data.tcp_alloc.claimed },
				udp: { allowed: data.udp_alloc.allowed, claimed: data.udp_alloc.claimed },
			};
		},
		createTunnel: async (input) => {
			const res = await call<{ id: string }>(
				baseUrl,
				'/tunnels/create',
				{
					name: input.name,
					tunnel_type: input.tunnel_type,
					port_type: input.port_type,
					port_count: 1,
					origin: {
						type: 'agent',
						data: { agent_id: input.agent_id, local_ip: input.local_ip, local_port: input.local_port },
					},
					enabled: true,
					alloc: null,
					firewall_id: null,
					proxy_protocol: null,
				},
				auth
			);
			return res.id;
		},
		deleteTunnel: async (tunnelId) => {
			await call<null>(baseUrl, '/tunnels/delete', { tunnel_id: tunnelId }, auth);
		},
	};
}

/** Registers a claim code and reports whether the user approved it on playit.gg. */
export function claimSetup(
	code: string,
	version: string,
	baseUrl = DEFAULT_BASE_URL
): Promise<PlayitClaimState> {
	return call<PlayitClaimState>(baseUrl, '/claim/setup', { code, agent_type: 'self-managed', version });
}

/** Exchanges an approved claim code for the agent secret key. */
export async function claimExchange(code: string, baseUrl = DEFAULT_BASE_URL): Promise<string> {
	const res = await call<{ secret_key: string }>(baseUrl, '/claim/exchange', { code });
	return res.secret_key;
}

export function claimUrl(code: string): string {
	return `https://playit.gg/claim/${code}`;
}

function toTunnel(t: RawAccountTunnel): PlayitTunnel {
	const a = t.alloc.status === 'allocated' ? t.alloc.data : undefined;
	return {
		id: t.id,
		name: t.name,
		tunnel_type: t.tunnel_type,
		port_type: t.port_type,
		allocation: a
			? { assigned_domain: a.assigned_domain, ip_hostname: a.ip_hostname, port_start: a.port_start }
			: null,
		disabled_reason: t.disabled_reason ?? null,
		local_ip: t.origin?.data?.local_ip ?? null,
		local_port: t.origin?.data?.local_port ?? null,
	};
}

async function call<T>(baseUrl: string, path: string, body: unknown, auth?: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res: Response;
	let text: string;
	try {
		res = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				...(auth ? { Authorization: auth } : {}),
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
		});
		text = await res.text();
	} catch (err) {
		throw new PlayitApiError(0, 'PLAYIT_NETWORK', `Playit API unreachable: ${(err as Error).message}`);
	} finally {
		clearTimeout(timer);
	}

	if (res.status === 429)
		throw new PlayitApiError(429, 'PLAYIT_RATE_LIMITED', 'Playit API rate limit hit; try again shortly');

	let envelope: { status?: string; data?: unknown } | null = null;
	try {
		envelope = JSON.parse(text);
	} catch {
		// handled below
	}
	if (envelope?.status === 'success') return envelope.data as T;

	// 'fail' carries an endpoint-specific error name (e.g. "RequiresPlayitPremium"),
	// 'error' carries {type, message} (e.g. auth/InvalidAgentKey).
	let code = `HTTP_${res.status}`;
	if (envelope?.status === 'fail') code = String(envelope.data);
	else if (envelope?.status === 'error') {
		const e = envelope.data as { type?: string; message?: unknown } | undefined;
		code = typeof e?.message === 'string' ? `${e?.type}:${e.message}` : String(e?.type ?? code);
	}
	log.warn({ status: res.status, code, path }, 'Playit API request failed');
	throw new PlayitApiError(res.status >= 400 ? res.status : 400, code, `Playit API ${path} failed: ${code}`);
}
