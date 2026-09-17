/**
 * Maps an AI-assistant tool name to where it happens in the UI, so callers
 * can point Cloudy at it: `walkTo(targetForTool('create_host')?.selector)`.
 */

export interface CloudyTarget {
	route: string;
	selector: string;
}

const TOOL_TARGETS: Record<string, CloudyTarget> = {
	get_health: { route: '/', selector: '[data-tour="dashboard-health"]' },
	get_health_deep: { route: '/', selector: '[data-tour="dashboard-health"]' },
	list_hosts: { route: '/hosts', selector: '[data-tour="hosts-mode-switch"]' },
	get_host: { route: '/hosts', selector: '[data-tour="hosts-mode-switch"]' },
	create_host: { route: '/hosts', selector: '[data-tour="hosts-add-btn"]' },
	toggle_host: { route: '/hosts', selector: '[data-tour="hosts-mode-switch"]' },
	delete_host: { route: '/hosts', selector: '[data-tour="hosts-mode-switch"]' },
	list_tunnels: { route: '/tunnels', selector: '[data-tour="tunnels-list"]' },
	get_tunnel_logs: { route: '/tunnels', selector: '[data-tour="tunnels-list"]' },
	restart_tunnel: { route: '/tunnels', selector: '[data-tour="tunnels-list"]' },
	list_cf_accounts: { route: '/cloudflare', selector: '[data-tour="cloudflare-accounts"]' },
	list_zones: { route: '/cloudflare', selector: '[data-tour="cloudflare-accounts"]' },
	get_audit_log: { route: '/audit', selector: '[data-tour="audit-filters"]' },
};

export function targetForTool(tool: string): CloudyTarget | null {
	return TOOL_TARGETS[tool] ?? null;
}
