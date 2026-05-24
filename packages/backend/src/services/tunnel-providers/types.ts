/**
 * Tunnel-provider abstraction.
 *
 * Every "tunnel" in CloudGate is owned by one provider. The provider is
 * responsible for whatever moving parts deliver public traffic to the
 * user's homelab — DNS, ingress config, agent process, API calls.
 *
 * Today: cloudflared (HTTP/HTTPS via Cloudflare Tunnel) +
 *        playit (TCP/UDP via Playit.gg).
 *
 * Adding a provider means:
 *   1. Implement TunnelProvider.
 *   2. Register it in tunnel-providers/index.ts.
 *   3. Extend the TunnelProviderSchema in @cloudgate/shared.
 */

import type { HostProtocol, ProviderEdgeEndpoint } from '@cloudgate/shared';

/** Live state of a managed tunnel — mirrors ManagedProcess statuses. */
export type ProviderStatus = 'starting' | 'running' | 'stopped' | 'error';

/** The minimal host info a provider needs to wire up a route/ingress. */
export interface HostBinding {
	id: number;
	hostname: string;
	protocol: HostProtocol;
	forward_host: string;
	forward_port: number;
	/** Only meaningful for http(s) — providers may ignore for tcp/udp. */
	forward_scheme: 'http' | 'https';
	/** Only meaningful for http(s); '/' is the catch-all. */
	path_prefix?: string;
	tls?: { no_tls_verify?: boolean };
}

/**
 * Provider contract. Every method is async / promise-returning so providers
 * can do I/O without exposing transport details to callers.
 *
 * Lifecycle methods (start/stop/reload) are not re-entrant — the caller
 * (host-deploy + tunnel-manager) serialises them per tunnel.
 */
export interface TunnelProvider {
	readonly name: 'cloudflared' | 'playit';
	/** Protocols this provider can carry. */
	readonly supports: ReadonlyArray<HostProtocol>;

	/** Bring the tunnel up. Idempotent — calling on a running tunnel is a no-op. */
	start(tunnelDbId: number): Promise<void>;
	/** Tear it down. Idempotent. */
	stop(tunnelDbId: number): Promise<void>;
	/**
	 * Re-apply config from the current DB state (after a host add/edit).
	 * Provider chooses signal vs API vs full restart.
	 */
	reload(tunnelDbId: number): Promise<void>;

	status(tunnelDbId: number): ProviderStatus;
	logs(tunnelDbId: number, maxLines?: number): string[];

	/**
	 * Wire a single host onto the tunnel. Returns the edge endpoint the
	 * caller should publish (CNAME for cloudflared, SRV/host_port for
	 * Playit). Idempotent — calling twice with the same host updates.
	 */
	addHost(tunnelDbId: number, host: HostBinding): Promise<ProviderEdgeEndpoint>;

	/** Remove a host. Idempotent — host already absent is OK. */
	removeHost(tunnelDbId: number, hostId: number): Promise<void>;
}

export type { ProviderEdgeEndpoint };
