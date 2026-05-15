/**
 * Persistence-contract test suite (skeleton).
 *
 * Per CLAUDE.md §6: enforces that no sacred path under /data/ is mutated by
 * the updater. Full implementation comes with M5 (Auto-Update).
 */

import { describe, expect, it } from 'vitest';

// The list of paths the updater MUST NOT touch (mirrors CLAUDE.md §1).
const SACRED_PATHS = [
	'/data/secrets',
	'/data/db/db.sqlite',
	'/data/cloudflared/bin',
	'/data/nginx/custom',
	'/data/nginx/certs',
	'/data/logs',
] as const;

describe('persistence contract', () => {
	it('placeholder: real fs.watch-based tests land in M5', () => {
		// TODO(M5):
		//  - simulate an update with the updater service
		//  - mount fs.watch over /data
		//  - assert no write event hits any path in SACRED_PATHS
		expect(SACRED_PATHS.length).toBeGreaterThan(0);
	});
});
