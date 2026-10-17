/**
 * Global cloudflared network settings, stored in the existing `settings`
 * key/value table (no migration — see CLAUDE.md §4). Read as
 * `stored ?? default`; anything outside the whitelist falls back to the
 * default, so a corrupt row can never reach the rendered config.yml.
 */

import {
	CloudflaredEdgeIpVersionSchema,
	type CloudflaredNetworkSettings,
	CloudflaredProtocolSchema,
} from '@cloudgate/shared';
import { getDb } from '../../../db/db.js';

const KEY_PROTOCOL = 'cloudflared.protocol';
const KEY_EDGE_IP = 'cloudflared.edge_ip_version';

export const DEFAULT_NETWORK_SETTINGS: CloudflaredNetworkSettings = {
	protocol: 'auto',
	edge_ip_version: '4',
};

function parseStored<T>(
	raw: string | undefined,
	schema: { safeParse(v: unknown): { success: boolean; data?: T } },
	fallback: T
): T {
	if (raw === undefined) return fallback;
	let value: unknown = raw;
	try {
		value = JSON.parse(raw);
	} catch {
		/* not JSON — try the raw string */
	}
	const r = schema.safeParse(value);
	return r.success ? (r.data as T) : fallback;
}

export async function getCloudflaredNetworkSettings(): Promise<CloudflaredNetworkSettings> {
	const rows = await getDb()<{ key: string; value: string }>('settings').whereIn('key', [
		KEY_PROTOCOL,
		KEY_EDGE_IP,
	]);
	const byKey = new Map(rows.map((r) => [r.key, r.value]));
	return {
		protocol: parseStored(
			byKey.get(KEY_PROTOCOL),
			CloudflaredProtocolSchema,
			DEFAULT_NETWORK_SETTINGS.protocol
		),
		edge_ip_version: parseStored(
			byKey.get(KEY_EDGE_IP),
			CloudflaredEdgeIpVersionSchema,
			DEFAULT_NETWORK_SETTINGS.edge_ip_version
		),
	};
}

export async function setCloudflaredNetworkSettings(
	patch: Partial<CloudflaredNetworkSettings>
): Promise<CloudflaredNetworkSettings> {
	const knex = getDb();
	const entries: Array<[string, string]> = [];
	if (patch.protocol !== undefined)
		entries.push([KEY_PROTOCOL, CloudflaredProtocolSchema.parse(patch.protocol)]);
	if (patch.edge_ip_version !== undefined) {
		entries.push([KEY_EDGE_IP, CloudflaredEdgeIpVersionSchema.parse(patch.edge_ip_version)]);
	}
	for (const [key, value] of entries) {
		await knex('settings')
			.insert({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() })
			.onConflict('key')
			.merge();
	}
	return getCloudflaredNetworkSettings();
}
