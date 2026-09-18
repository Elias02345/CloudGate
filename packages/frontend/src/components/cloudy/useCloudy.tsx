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
import { useLocation, useNavigate } from 'react-router-dom';
import { MOBILE_QUERY } from '../../layout.js';
import type { CloudyPose, CloudySign } from './types.js';

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

// Idle wandering tuning.
const WANDER_MIN_MS = 25_000;
const WANDER_MAX_MS = 60_000;
const SLEEPY_AFTER_MS = 3 * 60_000;
const WANDER_POSES: CloudyPose[] = ['idle', 'yawn', 'think', 'dance', 'shrug'];
// Cheap "is this spot free" probe for wandering: reject anything standing on real UI.
const INTERACTIVE_SELECTOR =
	'a,button,input,select,textarea,[role="button"],[data-tour],.mantine-Modal-content,.mantine-Drawer-content';

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

/** Keeps a top-left position fully on screen for a `size`-square figure. */
function clampToViewport(x: number, y: number, size: number): { x: number; y: number } {
	return {
		x: clamp(x, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerWidth - size - EDGE_MARGIN)),
		y: clamp(y, EDGE_MARGIN, Math.max(EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN)),
	};
}

/** Route-driven "resting" look — subtle, only meant for when he's idle. */
function ambientPoseFor(pathname: string): CloudyPose {
	return pathname.startsWith('/donate') ? 'love' : 'idle';
}
function ambientSignFor(pathname: string): CloudySign | null {
	if (pathname.startsWith('/donate')) return 'heart';
	if (pathname.startsWith('/updates')) return 'sparkle';
	return null;
}

/** Resting spot: beside the AI chat FAB when it's on screen, else the old fixed corner. */
function homePos(size: number): { x: number; y: number } {
	const affix = document.querySelector<HTMLElement>('.mantine-Affix-root');
	if (affix) {
		const rect = affix.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			return clampToViewport(rect.right + EDGE_MARGIN, rect.top + rect.height / 2 - size / 2, size);
		}
	}
	// AI chat disabled (autonomy off) or not yet mounted — old fixed spot.
	return clampToViewport(108, window.innerHeight - size - 40, size);
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

function rectsOverlap(box: { x: number; y: number; w: number; h: number }, r: DOMRect): boolean {
	return box.x < r.right && box.x + box.w > r.left && box.y < r.bottom && box.y + box.h > r.top;
}

/**
 * Stand beside (never on top of) a rect: prefer its left edge, flip if there's no room.
 * When `tooltipRect` is given (the guided tour's tooltip), skip any side that would land
 * him underneath it; if every side does, stand above/below the target instead.
 */
function standBeside(
	rect: DOMRect,
	size: number,
	tooltipRect?: DOMRect | null
): { x: number; y: number; facing: 'left' | 'right' } {
	const midY = clamp(
		rect.top + rect.height / 2 - size / 2,
		EDGE_MARGIN,
		window.innerHeight - size - EDGE_MARGIN
	);
	const midX = clamp(
		rect.left + rect.width / 2 - size / 2,
		EDGE_MARGIN,
		window.innerWidth - size - EDGE_MARGIN
	);
	const leftX = rect.left - size - EDGE_MARGIN;
	const rightX = clamp(rect.right + EDGE_MARGIN, EDGE_MARGIN, window.innerWidth - size - EDGE_MARGIN);
	const aboveY = rect.top - size - EDGE_MARGIN;
	const belowY = clamp(rect.bottom + EDGE_MARGIN, EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN);

	const candidates: Array<{ x: number; y: number; facing: 'left' | 'right' }> = [];
	if (leftX >= EDGE_MARGIN) candidates.push({ x: leftX, y: midY, facing: 'right' });
	candidates.push({ x: rightX, y: midY, facing: 'left' });
	if (aboveY >= EDGE_MARGIN) candidates.push({ x: midX, y: aboveY, facing: 'right' });
	candidates.push({ x: midX, y: belowY, facing: 'right' });

	if (tooltipRect) {
		const free = candidates.find((c) => !rectsOverlap({ x: c.x, y: c.y, w: size, h: size }, tooltipRect));
		if (free) return free;
	}
	// candidates[1] (right of target) is always pushed unconditionally, so this always exists.
	return candidates[0] ?? { x: rightX, y: midY, facing: 'left' };
}

/** Picks a free-looking spot along the bottom/side margins for idle wandering, or null if none found. */
// A stroll should be visible as one: anything shorter just looks like a twitch.
const WANDER_MIN_DISTANCE = 220;

function pickWanderSpot(size: number, from: { x: number; y: number }): { x: number; y: number } | null {
	for (let i = 0; i < 8; i++) {
		const onBottom = Math.random() < 0.6;
		const x = onBottom
			? clamp(Math.random() * window.innerWidth, EDGE_MARGIN, window.innerWidth - size - EDGE_MARGIN)
			: Math.random() < 0.5
				? EDGE_MARGIN
				: window.innerWidth - size - EDGE_MARGIN;
		const y = onBottom
			? window.innerHeight - size - EDGE_MARGIN
			: clamp(Math.random() * window.innerHeight, EDGE_MARGIN, window.innerHeight - size - EDGE_MARGIN);
		if (Math.hypot(x - from.x, y - from.y) < WANDER_MIN_DISTANCE) continue;
		const probe = document.elementFromPoint(x + size / 2, y + size / 2);
		if (!probe || !probe.closest(INTERACTIVE_SELECTOR)) return { x, y };
	}
	return null;
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
	// Last genuine user activity (pointer move / navigation) — drives the sleep emote and wake-up.
	const lastActivityRef = useRef(Date.now());

	// Current route, read from a ref so async callbacks (walk steps, timers) see the live value
	// instead of the one captured when they were scheduled.
	const location = useLocation();
	const routeRef = useRef(location.pathname);
	routeRef.current = location.pathname;

	// Tracked timeouts so wandering/flash timers always get cleared on unmount.
	const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
	const track = useCallback((fn: () => void, ms: number) => {
		const id = setTimeout(() => {
			timersRef.current.delete(id);
			fn();
		}, ms);
		timersRef.current.add(id);
	}, []);
	useEffect(
		() => () => {
			for (const id of timersRef.current) clearTimeout(id);
			timersRef.current.clear();
		},
		[]
	);

	const enqueue = useCallback((step: () => Promise<void>): Promise<void> => {
		setPending((n) => n + 1);
		const run = queueRef.current.then(step);
		queueRef.current = run.catch(() => undefined);
		run.finally(() => setPending((n) => n - 1));
		return run;
	}, []);

	const animateTo = useCallback(
		async (x: number, y: number, facing?: 'left' | 'right') => {
			const dest = clampToViewport(x, y, cloudySize());
			const from = posRef.current;
			const dist = Math.hypot(dest.x - from.x, dest.y - from.y);
			const reduced = prefersReducedMotion();
			const duration =
				dist < 4 || reduced ? 0 : clamp((dist / PX_PER_SEC) * 1000, MIN_DURATION_MS, MAX_DURATION_MS);
			const dir = facing ?? (dest.x >= from.x ? 'right' : 'left');
			posRef.current = dest;
			patchState({ visible: true, x: dest.x, y: dest.y, pose: 'walk', facing: dir, durationMs: duration });
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
					const tooltip = document.querySelector('.react-joyride__tooltip');
					dest = standBeside(el.getBoundingClientRect(), size, tooltip?.getBoundingClientRect() ?? null);
				}
				// not found within the timeout: resolve without moving, never throw
			} else {
				dest = target;
			}
			if (dest) await animateTo(dest.x, dest.y, dest.facing);
			// Landing with no explicit pose = settling idle: pick up the route's ambient look.
			// An explicit pose (tour's 'point', chat's 'work', ...) is a task, so clear any sign.
			patchState({
				pose: opts?.pose ?? ambientPoseFor(routeRef.current),
				sign: opts?.pose ? null : ambientSignFor(routeRef.current),
			});
			if (opts?.say) await stepSay(opts.say);
			if (opts?.holdMs) await delay(opts.holdMs);
		},
		[animateTo, patchState, stepSay]
	);

	const stepSetPose = useCallback(
		async (pose: CloudyPose, opts?: { ms?: number }) => {
			const idleLike = pose === 'idle' || pose === 'love' || pose === 'sleep';
			patchState({ visible: true, pose, sign: idleLike ? ambientSignFor(routeRef.current) : null });
			if (opts?.ms) await delay(opts.ms);
		},
		[patchState]
	);

	const stepGoHome = useCallback(async () => {
		const home = homePos(cloudySize());
		await animateTo(home.x, home.y, 'left');
		patchState({
			pose: ambientPoseFor(routeRef.current),
			sign: ambientSignFor(routeRef.current),
			bubble: null,
		});
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

	const apiRef = useRef(api);
	apiRef.current = api;
	const queryClient = useQueryClient();
	const { t } = useTranslation();
	const navigate = useNavigate();

	// He lives here: park him at his resting spot on mount so he is present and can wander,
	// instead of only appearing once something calls him.
	useEffect(() => {
		const size = cloudySize();
		const home = homePos(size);
		posRef.current = home;
		patchState({
			visible: true,
			x: home.x,
			y: home.y,
			durationMs: 0,
			pose: ambientPoseFor(routeRef.current),
			sign: ambientSignFor(routeRef.current),
		});
	}, [patchState]);

	// Bug fix: nothing used to re-clamp his position when the window resized (or a layout
	// reflow moved the element he was placed beside) while he sat idle. Movement itself is
	// clamped centrally in animateTo; this covers the "didn't move but the window did" case.
	useEffect(() => {
		const onResize = () => {
			const clamped = clampToViewport(posRef.current.x, posRef.current.y, cloudySize());
			if (clamped.x !== posRef.current.x || clamped.y !== posRef.current.y) {
				posRef.current = clamped;
				patchState({ x: clamped.x, y: clamped.y, durationMs: 0 });
			}
		};
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [patchState]);

	// Wake from sleep on the next pointer move, and remember it as activity for the sleep timer.
	useEffect(() => {
		const wake = () => {
			lastActivityRef.current = Date.now();
			setState((s) =>
				s.pose === 'sleep'
					? { ...s, pose: ambientPoseFor(routeRef.current), sign: ambientSignFor(routeRef.current) }
					: s
			);
		};
		window.addEventListener('pointermove', wake, { passive: true });
		return () => window.removeEventListener('pointermove', wake);
	}, []);

	// Route-aware sign/pose: navigating counts as activity (wakes him up), and while he's
	// resting (idle/love/sleep) and nothing else is queued, picks up the new route's look.
	useEffect(() => {
		lastActivityRef.current = Date.now();
		if (api.busy) return;
		setState((s) => {
			if (s.pose !== 'idle' && s.pose !== 'love' && s.pose !== 'sleep') return s;
			return { ...s, pose: ambientPoseFor(location.pathname), sign: ambientSignFor(location.pathname) };
		});
		// also re-runs when he stops being busy: on a fresh page load the queue is still
		// placing him when the route effect first fires, and the look would never be applied
	}, [location.pathname, api.busy]);

	// Idle wandering: every 25-60s, if nothing else is going on, stroll to a free spot and
	// emote, then settle. Disabled entirely under reduced motion.
	useEffect(() => {
		if (prefersReducedMotion()) return;
		let cancelled = false;

		const maybeWander = async () => {
			if (cancelled) return;
			if (document.visibilityState !== 'visible') return;
			if (apiRef.current.busy) return;
			if (document.querySelector('.react-joyride__overlay')) return;
			if (document.querySelector('.mantine-Drawer-content')) return;
			if (document.querySelector('.mantine-Modal-content')) return;
			const spot = pickWanderSpot(cloudySize(), posRef.current);
			if (!spot) return;

			const sleepy = Date.now() - lastActivityRef.current > SLEEPY_AFTER_MS;
			const pool = sleepy ? [...WANDER_POSES, 'sleep' as const] : WANDER_POSES;
			const emote = pool[Math.floor(Math.random() * pool.length)] ?? 'idle';

			await apiRef.current.walkTo(spot);
			if (emote === 'sleep') {
				await apiRef.current.setPose('sleep');
			} else if (emote !== 'idle') {
				await apiRef.current.setPose(emote, { ms: 1600 });
				await apiRef.current.setPose(ambientPoseFor(routeRef.current));
			}
		};

		const scheduleNext = () => {
			track(
				() => {
					void maybeWander().finally(() => {
						if (!cancelled) scheduleNext();
					});
				},
				WANDER_MIN_MS + Math.random() * (WANDER_MAX_MS - WANDER_MIN_MS)
			);
		};
		scheduleNext();

		return () => {
			cancelled = true;
		};
	}, [track]);

	// Support nudge: every 12th successful mutation, at most once/24h, offers the donate page.
	// Also: a brief "alert" flash + confused pose after any failed mutation, so a mistake
	// doesn't pass silently.
	// biome-ignore lint/correctness/useExhaustiveDependencies: apiRef/t/navigate/track are read live via refs/closures; re-subscribing on every render would drop the de-dupe sets
	useEffect(() => {
		const cache = queryClient.getMutationCache();
		const seenOk = new Set<number>();
		const seenErr = new Set<number>();
		const unsubscribe = cache.subscribe((event) => {
			if (event.type !== 'updated') return;
			const id = event.mutation.mutationId;

			if (event.mutation.state.status === 'error') {
				if (seenErr.has(id)) return;
				seenErr.add(id);
				if (apiRef.current.busy) return;
				setState((s) => (s.visible ? { ...s, pose: 'confused', sign: 'alert' } : s));
				track(() => {
					setState((s) =>
						s.pose === 'confused'
							? { ...s, pose: ambientPoseFor(routeRef.current), sign: ambientSignFor(routeRef.current) }
							: s
					);
				}, 1800);
				return;
			}

			if (event.mutation.state.status !== 'success') return;
			if (seenOk.has(id)) return;
			seenOk.add(id);

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
			await apiRef.current.walkTo(home);
			// Set after landing: the walk's own settle would otherwise overwrite this with
			// whatever the current route's ambient sign is.
			apiRef.current.hold('❤️');
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

	// Perch on the enlarged QR-code modal (Support page): watch for a Mantine modal whose
	// content holds an <svg> (qrcode.react), walk over and sit on its top edge, above the
	// modal overlay; leave again when it closes. MutationObserver, not polling.
	useEffect(() => {
		let perched = false;
		const check = () => {
			const modal = document.querySelector<HTMLElement>('.mantine-Modal-content');
			const hasQr = !!modal?.querySelector('svg');
			if (hasQr && modal && !perched) {
				perched = true;
				const rect = modal.getBoundingClientRect();
				const size = cloudySize();
				document.documentElement.style.setProperty('--cg-cloudy-z', '260');
				void apiRef.current.walkTo(
					{ x: rect.left + rect.width / 2 - size / 2, y: rect.top - size },
					{ pose: 'sit' }
				);
			} else if (!hasQr && perched) {
				perched = false;
				document.documentElement.style.removeProperty('--cg-cloudy-z');
				void apiRef.current.goHome();
			}
		};
		const observer = new MutationObserver(check);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			if (perched) document.documentElement.style.removeProperty('--cg-cloudy-z');
		};
	}, []);

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
