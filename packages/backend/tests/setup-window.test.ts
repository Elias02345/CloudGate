import { describe, expect, it } from 'vitest';
import { computeSetupWindow } from '../src/services/setup-window.js';

describe('computeSetupWindow', () => {
	const startedAt = Date.parse('2026-01-01T00:00:00.000Z');

	it('is open right at process start', () => {
		const w = computeSetupWindow(startedAt, 30, startedAt);
		expect(w.open).toBe(true);
		expect(w.closesAt).toBe('2026-01-01T00:30:00.000Z');
	});

	it('is still open just before it closes', () => {
		const w = computeSetupWindow(startedAt, 30, startedAt + 30 * 60_000 - 1);
		expect(w.open).toBe(true);
	});

	it('is closed exactly at the close instant', () => {
		const w = computeSetupWindow(startedAt, 30, startedAt + 30 * 60_000);
		expect(w.open).toBe(false);
	});

	it('is closed well after the window', () => {
		const w = computeSetupWindow(startedAt, 30, startedAt + 60 * 60_000);
		expect(w.open).toBe(false);
	});

	it('honours a custom window length', () => {
		const w = computeSetupWindow(startedAt, 5, startedAt + 4 * 60_000);
		expect(w.open).toBe(true);
		const closed = computeSetupWindow(startedAt, 5, startedAt + 6 * 60_000);
		expect(closed.open).toBe(false);
	});
});
