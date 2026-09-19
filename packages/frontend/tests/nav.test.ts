/**
 * The sidebar's two pieces of actual logic.
 *
 * `to` matters more than it looks: each item renders as `<NavLink component={Link} to={...}>`,
 * which is what makes it a real `<a href>`. Before that, the items were
 * `<NavLink onClick={...}>` — an anchor with no href, which is not in the tab
 * order, so the entire primary navigation was unreachable by keyboard.
 */
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, isActive } from '../src/App.js';

describe('NAV_ITEMS', () => {
	it('every item has a route to link to', () => {
		expect(NAV_ITEMS.length).toBeGreaterThan(0);
		for (const item of NAV_ITEMS) {
			expect(item.to.startsWith('/'), `${item.to} must be an absolute path`).toBe(true);
		}
	});

	it('every item is labelled, one way or the other', () => {
		for (const item of NAV_ITEMS) {
			expect(Boolean(item.labelKey ?? item.label), `${item.to} has no label`).toBe(true);
		}
	});

	it('no route appears twice', () => {
		const routes = NAV_ITEMS.map((i) => i.to);
		expect(new Set(routes).size).toBe(routes.length);
	});
});

describe('isActive', () => {
	it('matches the dashboard only on exactly /', () => {
		expect(isActive('/', '/')).toBe(true);
		// The bug this guards: startsWith('/') is true for every route there is,
		// which would light up the dashboard on every page.
		expect(isActive('/hosts', '/')).toBe(false);
	});

	it('matches a section and everything under it', () => {
		expect(isActive('/hosts', '/hosts')).toBe(true);
		expect(isActive('/hosts/new', '/hosts')).toBe(true);
		expect(isActive('/tunnels', '/hosts')).toBe(false);
	});

	it('marks exactly one item active for each of its own routes', () => {
		for (const item of NAV_ITEMS) {
			const active = NAV_ITEMS.filter((candidate) => isActive(item.to, candidate.to));
			expect(active.map((a) => a.to), `path ${item.to}`).toEqual([item.to]);
		}
	});
});
