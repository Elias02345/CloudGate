/**
 * First-run setup window — POST /api/setup is only reachable for N minutes
 * after process start (CLOUDGATE_SETUP_WINDOW_MINUTES, default 30). A
 * restart of the container/app reopens it.
 *
 * `computeSetupWindow` is pure (clock injected) so it can be unit tested
 * without faking global time. `PROCESS_STARTED_AT` captures the one real
 * clock reading, at module load — i.e. process start.
 */

export const PROCESS_STARTED_AT: number = Date.now();

export interface SetupWindow {
	open: boolean;
	closesAt: string;
}

export function computeSetupWindow(startedAtMs: number, windowMinutes: number, nowMs: number): SetupWindow {
	const closesAtMs = startedAtMs + windowMinutes * 60_000;
	return { open: nowMs < closesAtMs, closesAt: new Date(closesAtMs).toISOString() };
}
