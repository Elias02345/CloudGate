/**
 * Wires the backend SSE stream into TanStack Query invalidations.
 *
 * Uses an EventSource with the access token in a query param (EventSource
 * doesn't support custom headers).
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getStoredToken } from './client.js';

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
		const token = getStoredToken();
		if (!token) return;
		const url = `/api/events?access_token=${encodeURIComponent(token)}`;
		const es = new EventSource(url);

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

		for (const topic of Object.keys(TOPIC_QUERY_KEYS)) {
			es.addEventListener(topic, onMessage as EventListener);
		}
		es.addEventListener('error', () => {
			// EventSource will auto-reconnect; nothing to do here
		});

		return () => {
			es.close();
		};
	}, [qc]);
}
