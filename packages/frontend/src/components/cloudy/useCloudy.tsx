/**
 * Cloudy's imperative stage controller.
 *
 * `CloudyProvider` owns where he is and what he's doing; `useCloudy()` hands
 * callers a small queued API to move him around ("go stand next to the
 * create-host button and say hi"). `useCloudyRenderState()` is the matching
 * read side for `CloudyStage.tsx` — both live here since they share all the
 * position/animation math.
 */

import { Button, Group, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { MOBILE_QUERY } from '../../layout.js';
import type { CloudyPose } from './types.js';

export interface CloudyApi {
	walkTo(
		target: string | { x: number; y: number },
		opts?: { say?: string; pose?: CloudyPose; holdMs?: number }
	): Promise<void>;
	say(text: string, opts?: { ms?: number }): Promise<void>;
	setPose(pose: CloudyPose, opts?: { ms?: number }): Promise<void>;
	hold(sign: ReactNode | null): void;
	goHome(): Promise<void>;
	hide(): void;
	readonly busy: boolean;
}

interface RenderState {
	visible: boolean;
	x: number;
	y: number;
	pose: CloudyPose;
	facing: 'left' | 'right';
	sign: ReactNode | null;
	bubble: ReactNode | null;
	durationMs: number;
	/** Only the support nudge wires click-to-dismiss; a guided walk shouldn't. */
	dismissible: boolean;
}

const DESKTOP_SIZE = 64;
const MOBILE_SIZE = 44;
const PX_PER_SEC = 420;
const MIN_DURATION_MS = 350;
const MAX_DURATION_MS = 2200;
const EDGE_MARGIN = 16;

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function prefersReducedMotion(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cloudySize(): number {
	return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
		? MOBILE_SIZE
		: DESKTOP_SIZE;
}

/** Resting spot: bottom-left, beside the AI chat FAB (which sits at left:40, bottom:32). */
function homePos(size: number): { x: number; y: number } {
	return { x: 108, y: window.innerHeight - size - 40 };
}

/** Polls for the element; resolves null (never rejects) if it never shows up. */
function waitForElement(selector: string, timeoutMs = 3000): Promise<HTMLElement | null> {
	return new Promise((resolve) => {
		const immediate = document.querySelector<HTMLElement>(selector);
		if (immediate) {
			resolve(immediate);
			return;
		}
		const start = performance.now();
		const id = window.setInterval(() => {
			const el = document.querySelector<HTMLElement>(selector);
			if (el || performance.now() - start > timeoutMs) {
				window.clearInterval(id);
				resolve(el);
			}
		}, 150);
	});
}

// ponytail: heuristic settle-detection (debounce scroll events, cap at maxMs) rather than a
// real "smooth scroll finished" event — the platform doesn't expose one.
function waitForScrollSettle(maxMs = 1200): Promise<void> {
	return new Promise((resolve) => {
		let settleTimer: ReturnType<typeof setTimeout>;
		const finish = () => {
			window.removeEventListener('scroll', onScroll, true);
			clearTimeout(settleTimer);
			clearTimeout(maxTimer);
			resolve();
		};
		const onScroll = () => {
			clearTimeout(settleTimer);
			settleTimer = setTimeout(finish, 150);
		};
		window.addEventListener('scroll', onScroll, true);
		settleTimer = setTimeout(finish, 150);
		const maxTimer = setTimeout(finish, maxMs);
	});
}

/** Stand beside (never on top of) a rect: prefer its left edge, flip if there's no room. */
function standBeside(rect: DOMRect, size: number): { x: number; y: number; facing: 'left' | 'right' } {
	const fitsLeft = rect.left - size - EDGE_MARGIN >= 0;
	const x = fitsLeft
		? rect.left - size - EDGE_MARGIN
		: clamp(rect.right + EDGE_MARGIN, EDGE_MARGIN, window.innerWidth - size - EDGE_MARGIN);
	const y = clamp(
		rect.top + rect.height / 2 - size / 2,
		EDGE_MARGIN,
		window.innerHeight - size - EDGE_MARGIN
	);
	return { x: Math.max(EDGE_MARGIN, x), y, facing: fitsLeft ? 'right' : 'left' };
}

const initialState: RenderState = {
	visible: false,
	x: 108,
	y: 108,
	pose: 'idle',
	facing: 'right',
	sign: null,
	bubble: null,
	durationMs: 0,
	dismissible: false,
};

const CloudyStateContext = createContext<RenderState>(initialState);
const CloudyApiContext = createContext<CloudyApi | null>(null);

const NUDGE_KEY = 'cloudy.nudge';
const NUDGE_EVERY = 12;
const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function readNudgeState(): { count: number; lastAt: number } {
	try {
		const raw = localStorage.getItem(NUDGE_KEY);
		return raw ? JSON.parse(raw) : { count: 0, lastAt: 0 };
	} catch {
		return { count: 0, lastAt: 0 };
	}
}

function writeNudgeState(s: { count: number; lastAt: number }): void {
	try {
		localStorage.setItem(NUDGE_KEY, JSON.stringify(s));
	} catch {
		// private browsing / quota — the nudge just won't remember, not worth surfacing
	}
}

export function CloudyProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<RenderState>(initialState);
	const patchState = useCallback((patch: Partial<RenderState>) => {
		setState((s) => ({ ...s, dismissible: false, ...patch }));
	}, []);

	const posRef = useRef({ x: initialState.x, y: initialState.y });
	const queueRef = useRef<Promise<void>>(Promise.resolve());
	const [pending, setPending] = useState(0);

	const enqueue = useCallback((step: () => Promise<void>): Promise<void> => {
		setPending((n) => n + 1);
		const run = queueRef.current.then(step);
		queueRef.current = run.catch(() => undefined);
		run.finally(() => setPending((n) => n - 1));
		return run;
	}, []);

	const animateTo = useCallback(
		async (x: number, y: number, facing?: 'left' | 'right') => {
			const from = posRef.current;
			const dist = Math.hypot(x - from.x, y - from.y);
			const reduced = prefersReducedMotion();
			const duration =
				dist < 4 || reduced ? 0 : clamp((dist / PX_PER_SEC) * 1000, MIN_DURATION_MS, MAX_DURATION_MS);
			const dir = facing ?? (x >= from.x ? 'right' : 'left');
			posRef.current = { x, y };
			patchState({ visible: true, x, y, pose: 'walk', facing: dir, durationMs: duration });
			if (duration > 0) await delay(duration);
		},
		[patchState]
	);

	const stepSay = useCallback(
		async (text: string, opts?: { ms?: number }) => {
			const ms = opts?.ms ?? clamp(1200 + text.length * 35, 1500, 5000);
			patchState({ visible: true, bubble: text });
			await delay(ms);
			patchState({ bubble: null });
		},
		[patchState]
	);

	const stepWalkTo = useCallback(
		async (
			target: string | { x: number; y: number },
			opts?: { say?: string; pose?: CloudyPose; holdMs?: number }
		) => {
			const size = cloudySize();
			let dest: { x: number; y: number; facing?: 'left' | 'right' } | null = null;
			if (typeof target === 'string') {
				const el = await waitForElement(target);
				if (el) {
					el.scrollIntoView({ block: 'center', behavior: 'smooth' });
					await waitForScrollSettle();
					dest = standBeside(el.getBoundingClientRect(), size);
				}
				// not found within the timeout: resolve without moving, never throw
			} else {
				dest = target;
			}
			if (dest) await animateTo(dest.x, dest.y, dest.facing);
			patchState({ pose: opts?.pose ?? 'idle' });
			if (opts?.say) await stepSay(opts.say);
			if (opts?.holdMs) await delay(opts.holdMs);
		},
		[animateTo, patchState, stepSay]
	);

	const stepSetPose = useCallback(
		async (pose: CloudyPose, opts?: { ms?: number }) => {
			patchState({ visible: true, pose });
			if (opts?.ms) await delay(opts.ms);
		},
		[patchState]
	);

	const stepGoHome = useCallback(async () => {
		const home = homePos(cloudySize());
		await animateTo(home.x, home.y, 'left');
		patchState({ pose: 'idle', sign: null, bubble: null });
	}, [animateTo, patchState]);

	const hold = useCallback(
		(sign: ReactNode | null) => {
			patchState({ visible: true, sign });
		},
		[patchState]
	);

	const hide = useCallback(() => {
		patchState({ visible: false, bubble: null });
	}, [patchState]);

	const walkTo = useCallback(
		(
			target: string | { x: number; y: number },
			opts?: { say?: string; pose?: CloudyPose; holdMs?: number }
		) => enqueue(() => stepWalkTo(target, opts)),
		[enqueue, stepWalkTo]
	);
	const say = useCallback(
		(text: string, opts?: { ms?: number }) => enqueue(() => stepSay(text, opts)),
		[enqueue, stepSay]
	);
	const setPose = useCallback(
		(pose: CloudyPose, opts?: { ms?: number }) => enqueue(() => stepSetPose(pose, opts)),
		[enqueue, stepSetPose]
	);
	const goHome = useCallback(() => enqueue(stepGoHome), [enqueue, stepGoHome]);

	const api = useMemo<CloudyApi>(
		() => ({ walkTo, say, setPose, hold, goHome, hide, busy: pending > 0 }),
		[walkTo, say, setPose, hold, goHome, hide, pending]
	);

	// Dev only: lets the dev tools drive Cloudy while tuning his choreography
	if (import.meta.env.DEV) {
		(window as unknown as { cloudy?: CloudyApi }).cloudy = api;
	}

	// Support nudge: every 12th successful mutation, at most once/24h, offers the donate page.
	const apiRef = useRef(api);
	apiRef.current = api;
	const queryClient = useQueryClient();
	const { t } = useTranslation();
	const navigate = useNavigate();

	// biome-ignore lint/correctness/useExhaustiveDependencies: apiRef/t/navigate are read live via refs/closures; re-subscribing on every render would drop the `seen` de-dupe set
	useEffect(() => {
		const cache = queryClient.getMutationCache();
		const seen = new Set<number>();
		const unsubscribe = cache.subscribe((event) => {
			if (event.type !== 'updated' || event.mutation.state.status !== 'success') return;
			if (seen.has(event.mutation.mutationId)) return;
			seen.add(event.mutation.mutationId);

			const nudge = readNudgeState();
			const count = nudge.count + 1;
			if (count % NUDGE_EVERY !== 0 || Date.now() - nudge.lastAt < NUDGE_COOLDOWN_MS || apiRef.current.busy) {
				writeNudgeState({ ...nudge, count });
				return;
			}
			writeNudgeState({ count, lastAt: Date.now() });
			void runNudge();
		});
		return unsubscribe;

		async function runNudge() {
			const home = homePos(cloudySize());
			apiRef.current.hold('❤️');
			await apiRef.current.walkTo(home);
			const text = t('cloudy.nudge_text', {
				defaultValue:
					"Thanks for keeping CloudGate running! If it's been useful, consider supporting the project.",
			});
			const cta = t('cloudy.nudge_cta', { defaultValue: 'Support the project' });
			setState((s) => ({
				...s,
				dismissible: true,
				bubble: (
					<Stack gap={6}>
						<Text size="xs">{text}</Text>
						<Group gap={6} justify="flex-end">
							<Button
								size="xs"
								variant="light"
								color="pink"
								onClick={() => {
									navigate('/donate');
									void apiRef.current.goHome();
								}}
							>
								{cta}
							</Button>
						</Group>
					</Stack>
				),
			}));
		}
	}, [queryClient]);

	return (
		<CloudyApiContext.Provider value={api}>
			<CloudyStateContext.Provider value={state}>{children}</CloudyStateContext.Provider>
		</CloudyApiContext.Provider>
	);
}

export function useCloudy(): CloudyApi {
	const api = useContext(CloudyApiContext);
	if (!api) throw new Error('useCloudy() must be used inside <CloudyProvider>');
	return api;
}

/** Internal: read side for CloudyStage.tsx. Not for consumers outside cloudy/. */
export function useCloudyRenderState(): RenderState {
	return useContext(CloudyStateContext);
}

export { DESKTOP_SIZE, MOBILE_SIZE, cloudySize };
