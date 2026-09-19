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

/**
 * Fired once when a request comes back 401 with a token in hand, i.e. the
 * session is gone. An event rather than a direct call into the query client:
 * this module sits at the bottom of the import graph and must not depend on
 * React or on main.tsx.
 */
export const UNAUTHORIZED_EVENT = 'cloudgate:unauthorized';

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

		// A dead session used to go unnoticed everywhere except /auth/me.
		// Every other query just threw, TanStack Query kept the last good
		// data, and the app carried on showing it as if it were current —
		// polling in the background, failing silently, logging nobody out.
		// The token is dropped here and the app told once, so whichever
		// request hits it first is enough to end the session.
		//
		// Keyed on the CODE, not the status. A 401 does not mean "your session
		// is over": the backend also answers 401 for a wrong current password
		// (`AUTH_FAILED`) and a wrong second factor (`TOTP_*`), both sent with
		// a perfectly good token. Gating on the status logged people out for
		// mistyping their password on the change-password form — the request
		// they were making at that exact moment. `UNAUTHENTICATED` comes only
		// from the auth middleware, i.e. only when the token itself is
		// missing, invalid, expired or revoked.
		if (res.status === 401 && code === 'UNAUTHENTICATED' && token) {
			setStoredToken(null);
			window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
		}

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
