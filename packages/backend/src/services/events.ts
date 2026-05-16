/**
 * Simple SSE event bus.
 *
 * - publish(topic, payload) — fan out to all clients subscribed to the topic
 *   (or 'all' subscriptions).
 * - subscribe(res, topics) — registers an Express response as a long-lived
 *   SSE stream. Returns an unsubscribe fn.
 *
 * Implementation is in-process / singleton. Multi-instance support would
 * require a pub/sub backend, but for self-hosted single-process CloudGate
 * this is enough.
 */

import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { childLogger } from '../logger.js';

const log = childLogger('events');

export type EventTopic =
	| 'host.deployed'
	| 'host.deploy_failed'
	| 'host.deleted'
	| 'host.toggled'
	| 'tunnel.status'
	| 'tunnel.created'
	| 'tunnel.deleted'
	| 'update.available'
	| 'update.installing'
	| 'update.completed'
	| 'update.failed';

export interface EventEnvelope<T = unknown> {
	topic: EventTopic;
	payload: T;
	at: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0); // unlimited subscribers

export function publish<T>(topic: EventTopic, payload: T): void {
	const envelope: EventEnvelope<T> = { topic, payload, at: new Date().toISOString() };
	bus.emit('event', envelope);
}

interface SubscribeOptions {
	topics?: EventTopic[]; // empty / undefined = all
}

export function subscribe(res: Response, opts: SubscribeOptions = {}): () => void {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
	res.flushHeaders?.();

	const topicSet = opts.topics ? new Set(opts.topics) : null;

	// Initial comment to keep the connection open through proxies
	res.write(': cloudgate-sse-open\n\n');

	const onEvent = (env: EventEnvelope) => {
		if (topicSet && !topicSet.has(env.topic)) return;
		try {
			res.write(`event: ${env.topic}\n`);
			res.write(`data: ${JSON.stringify(env)}\n\n`);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'SSE write failed; removing subscriber');
			cleanup();
		}
	};

	// Heartbeat every 25s to keep proxies happy
	const ping = setInterval(() => {
		try {
			res.write(': ping\n\n');
		} catch {
			cleanup();
		}
	}, 25_000);
	ping.unref?.();

	const cleanup = (): void => {
		bus.off('event', onEvent);
		clearInterval(ping);
		try {
			res.end();
		} catch {
			/* already closed */
		}
	};

	bus.on('event', onEvent);

	res.req.on('close', cleanup);
	res.req.on('error', cleanup);

	return cleanup;
}
