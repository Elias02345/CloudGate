/**
 * Wires the backend SSE stream into TanStack Query invalidations.
 *
 * EventSource cannot set headers, so the credential has to go in the URL —
 * where nginx writes it to the access log on every page load. So it is not the
 * session token that goes there but a ticket fetched from the API: one minute
 * long, and accepted nowhere but this stream.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, getStoredToken } from './client.js';

const TOPIC_QUERY_KEYS: Record<string, string[][]> = {
	'host.deployed': [['hosts']],
	'host.deploy_failed': [['hosts']],
	'host.deleted': [['hosts']],
	'host.toggled': [['hosts']],
	'tunnel.status': [['tunnels']],
	'tunnel.created': [['tunnels']],
	'tunnel.deleted': [['tunnels']],
};

export function useEventStream(): void {
	const qc = useQueryClient();
	useEffect(() => {
		if (!getStoredToken()) return;

		let es: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		let closed = false;
		let backoffMs = 1000;

		const onMessage = (ev: MessageEvent): void => {
			try {
				const data = JSON.parse(ev.data) as { topic: string };
				const keys = TOPIC_QUERY_KEYS[data.topic];
				if (keys) {
					for (const key of keys) {
						qc.invalidateQueries({ queryKey: key });
					}
				}
			} catch {
				/* ignore malformed */
			}
		};

		// A ticket outlives its usefulness in a minute, so EventSource's own
		// reconnect — which replays the original URL — would just retry a dead
		// credential forever. Reconnect ourselves with a fresh one instead.
		const connect = async (): Promise<void> => {
			if (closed) return;
			let ticket: string;
			try {
				ticket = (await api<{ ticket: string }>('/events/ticket', { method: 'POST' })).ticket;
			} catch {
				// Usually a dropped session or a backend restart. Back off and
				// try again; live updates are a convenience, not a dependency.
				scheduleRetry();
				return;
			}
			if (closed) return;

			es = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
			for (const topic of Object.keys(TOPIC_QUERY_KEYS)) {
				es.addEventListener(topic, onMessage as EventListener);
			}
			es.addEventListener('open', () => {
				backoffMs = 1000;
			});
			es.addEventListener('error', () => {
				es?.close();
				es = null;
				scheduleRetry();
			});
		};

		const scheduleRetry = (): void => {
			if (closed || retry) return;
			retry = setTimeout(() => {
				retry = null;
				void connect();
			}, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
		};

		void connect();

		return () => {
			closed = true;
			if (retry) clearTimeout(retry);
			es?.close();
		};
	}, [qc]);
}
