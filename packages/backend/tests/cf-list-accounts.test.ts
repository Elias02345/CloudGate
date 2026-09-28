/**
 * listAccounts derives accounts from the token's zones (#68): GET /accounts
 * returns nothing for tokens without Account Settings:Read, which the setup
 * guide never asks for.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare', () => ({
	default: class {
		zones = {
			async *list() {
				yield { id: 'z1', account: { id: 'acc1', name: 'Home' } };
				yield { id: 'z2', account: { id: 'acc1', name: 'Home' } };
				yield { id: 'z3', account: { id: 'acc2' } };
				yield { id: 'z4', account: {} };
			},
		};
	},
}));

describe('listAccounts', () => {
	it('returns each zone account once and skips zones without one', async () => {
		const { listAccounts } = await import('../src/services/cloudflare-client.js');
		expect(await listAccounts('token')).toEqual([
			{ id: 'acc1', name: 'Home' },
			{ id: 'acc2', name: 'acc2' },
		]);
	});
});
