/**
 * Tunnel-provider registry.
 *
 * One instance per provider name, lazily constructed. Callers ask the
 * registry to resolve a tunnel row's provider; the registry instantiates
 * (and caches) the right TunnelProvider.
 *
 * Adding a provider:
 *   1. Implement TunnelProvider (see types.ts).
 *   2. Register it in `INSTANTIATORS` below.
 *   3. Add the name to `TunnelProviderSchema` in @cloudgate/shared.
 */

import type { TunnelProviderName } from '@cloudgate/shared';
import { getDb } from '../../db/db.js';
import { childLogger } from '../../logger.js';
import { CloudflaredProvider } from './cloudflared/provider.js';
import { PlayitProvider } from './playit/provider.js';
import type { TunnelProvider } from './types.js';

const log = childLogger('tunnel-providers');

type Instantiator = () => TunnelProvider;

const INSTANTIATORS: Record<TunnelProviderName, Instantiator> = {
	cloudflared: () => new CloudflaredProvider(),
	playit: () => new PlayitProvider(),
};

const instances = new Map<TunnelProviderName, TunnelProvider>();

export function getProvider(name: TunnelProviderName): TunnelProvider {
	let inst = instances.get(name);
	if (!inst) {
		const factory = INSTANTIATORS[name];
		if (!factory) throw new Error(`unknown tunnel provider: ${name}`);
		inst = factory();
		instances.set(name, inst);
	}
	return inst;
}

/**
 * Backend boot: revive every tunnel row by delegating start() to its
 * provider. Failures are logged + persisted as `status='error'` but do
 * NOT abort the boot — other tunnels (and the API) keep working.
 */
export async function initAll(): Promise<void> {
	const knex = getDb();
	type Row = { id: number; name: string; provider: TunnelProviderName | null };
	const rows = await knex<Row>('tunnels').select('id', 'name', 'provider');
	for (const row of rows) {
		const providerName = (row.provider ?? 'cloudflared') as TunnelProviderName;
		try {
			const provider = getProvider(providerName);
			await provider.start(row.id);
			log.info({ tunnel: row.name, provider: providerName }, 'Revived tunnel on boot');
		} catch (err) {
			log.error(
				{ err: (err as Error).message, tunnel: row.name, provider: providerName },
				'Failed to revive tunnel on boot'
			);
			await knex('tunnels').where({ id: row.id }).update({
				status: 'error',
				last_status_at: new Date().toISOString(),
			});
		}
	}
}
