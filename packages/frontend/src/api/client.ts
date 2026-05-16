/**
 * Tiny fetch wrapper.
 *
 * - Reads access token from localStorage and adds Bearer header.
 * - Throws ApiError on non-2xx with the parsed JSON body.
 * - Caller is responsible for catching + dispatching the error.
 */

const TOKEN_KEY = 'cloudgate.access_token';

export class ApiError extends Error {
	status: number;
	code: string;
	details?: unknown;

	constructor(status: number, code: string, message: string, details?: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export function getStoredToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setStoredToken(token: string | null): void {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		/* private mode etc. */
	}
}

export async function api<T>(
	path: string,
	options: {
		method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
		body?: unknown;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	} = {}
): Promise<T> {
	const token = getStoredToken();
	const headers: Record<string, string> = {
		Accept: 'application/json',
		...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		...options.headers,
	};

	const res = await fetch(`/api${path}`, {
		method: options.method ?? 'GET',
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
		signal: options.signal,
	});

	const text = await res.text();
	const data = text ? safeJsonParse(text) : null;

	if (!res.ok) {
		const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
		const code = (data as { code?: string } | null)?.code ?? 'HTTP_ERROR';
		const details = (data as { details?: unknown } | null)?.details;
		throw new ApiError(res.status, code, message, details);
	}

	return data as T;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
