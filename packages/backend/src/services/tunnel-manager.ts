/**
 * Thin facade over the tunnel-provider registry.
 *
 * Existed historically as the cloudflared lifecycle owner; now delegates
 * everything to the provider resolved from `tunnels.provider`. Kept under
 * this name so existing routes (`routes/tunnels.ts`, `host-deploy.ts`)
 * don't need to change their imports.
 */

import type { TunnelProviderName } from '@cloudgate/shared';
import { getDb } from '../db/db.js';
import { childLogger } from '../logger.js';
import { getProvider, initAll } from './tunnel-providers/index.js';

const log = childLogger('tunnel-manager');

async function resolveProvider(tunnelDbId: number): Promise<{ providerName: TunnelProviderName }> {
	const knex = getDb();
	const row = await knex<{ provider: string | null }>('tunnels')
		.where({ id: tunnelDbId })
		.select('provider')
		.first();
	if (!row) throw new Error(`tunnel ${tunnelDbId} not found`);
	return { providerName: (row.provider ?? 'cloudflared') as TunnelProviderName };
}

export async function startTunnel(tunnelDbId: number): Promise<void> {
	const { providerName } = await resolveProvider(tunnelDbId);
	await getProvider(providerName).start(tunnelDbId);
}

export async function stopTunnel(tunnelDbId: number): Promise<void> {
	const { providerName } = await resolveProvider(tunnelDbId);
	await getProvider(providerName).stop(tunnelDbId);
}

export async function reloadTunnel(tunnelDbId: number): Promise<void> {
	const { providerName } = await resolveProvider(tunnelDbId);
	await getProvider(providerName).reload(tunnelDbId);
}

/**
 * Status lookup is synchronous to match the historical API used by route
 * handlers. We accept an in-memory provider lookup that may report
 * "stopped" if the row hasn't been started yet on this process.
 */
export function statusOf(tunnelDbId: number, providerHint?: TunnelProviderName): string {
	// Without a hint we have to look the row up async, which would break the
	// sync contract. Callers that know the provider should pass it; the
	// default falls back to cloudflared which works for legacy rows.
	const name = providerHint ?? 'cloudflared';
	try {
		return getProvider(name).status(tunnelDbId);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'statusOf failed');
		return 'stopped';
	}
}

export function logsOf(tunnelDbId: number, maxLines = 200, providerHint?: TunnelProviderName): string[] {
	const name = providerHint ?? 'cloudflared';
	try {
		return getProvider(name).logs(tunnelDbId, maxLines);
	} catch {
		return [];
	}
}

/** Backend boot: delegate to the registry's initAll. */
export async function init(): Promise<void> {
	await initAll();
}
