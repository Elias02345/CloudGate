/**
 * @deprecated Moved to `services/tunnel-providers/cloudflared/config-writer.ts`.
 * Re-exported here so existing imports (routes/tunnels.ts, tests) keep working.
 */
export {
	buildContext,
	readCurrentConfig,
	renderConfig,
	writeConfig,
	type RenderContext,
	type RenderHost,
} from './tunnel-providers/cloudflared/config-writer.js';
