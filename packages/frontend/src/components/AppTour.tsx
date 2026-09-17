/**
 * App-wide guided tour using react-joyride.
 *
 * Behaviour:
 *   - <AppTourProvider> wraps the app. Reads `flags` from /me and decides
 *     whether to auto-start (after onboarding, when tour_completed_at is null
 *     and tour_dismissed is false).
 *   - Also auto-starts when URL contains `?tour=auto` or `?tour=replay`.
 *   - Cross-page navigation: each TourStop knows its `route`; `goTo` navigates
 *     and only resumes the spotlight once the target is rendered.
 *   - Phones: stops whose target is hidden there use `mobileTarget`.
 *   - Persistence: skip → tour_dismissed = true, finish → tour_completed_at.
 *
 * The `useAppTour()` hook lets any component start/stop the tour
 * (e.g. Settings replay button).
 */

import { useComputedColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Joyride, { ACTIONS, EVENTS, STATUS, type CallBackProps, type Step } from 'react-joyride';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe, usePatchUserFlags } from '../api/auth.js';
import { MOBILE_QUERY } from '../layout.js';
import { TOUR_STOPS, type TourStop } from './tour/tour-steps.js';

interface AppTourContextValue {
	running: boolean;
	start: () => void;
	stop: () => void;
}

const AppTourContext = createContext<AppTourContextValue>({
	running: false,
	start: () => {},
	stop: () => {},
});

export function useAppTour(): AppTourContextValue {
	return useContext(AppTourContext);
}

function targetOf(stop: TourStop, mobile: boolean): string {
	return mobile && stop.mobileTarget ? stop.mobileTarget : stop.target;
}

/** Resolves once `selector` matches a rendered, non-empty element — or after `timeoutMs` (Joyride then reports TARGET_NOT_FOUND). */
function waitForTarget(selector: string, timeoutMs = 4000): Promise<void> {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const tick = () => {
			const r = document.querySelector(selector)?.getBoundingClientRect();
			if ((r && r.width > 0 && r.height > 0) || Date.now() - t0 > timeoutMs) {
				resolve();
				return;
			}
			setTimeout(tick, 100);
		};
		tick();
	});
}

export function AppTourProvider({ children }: { children: React.ReactNode }) {
	const { t, i18n } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: me } = useMe();
	const patchFlags = usePatchUserFlags();
	const isMobile = useMediaQuery(MOBILE_QUERY) ?? false;
	const scheme = useComputedColorScheme('dark');

	const [running, setRunning] = useState(false);
	const [stepIndex, setStepIndex] = useState(0);
	const autoStartedRef = useRef(false);
	// Read from async step transitions: current path, and a token that cancels stale ones
	const pathRef = useRef(location.pathname);
	pathRef.current = location.pathname;
	const goToken = useRef(0);

	// Build the Joyride step array from TOUR_STOPS + i18n. Re-runs on language
	// change because `t` updates.
	const steps: Step[] = useMemo(
		() =>
			TOUR_STOPS.map((stop) => ({
				target: targetOf(stop, isMobile),
				placement: isMobile ? 'auto' : stop.placement,
				disableBeacon: true,
				title: t(`${stop.i18nKey}_title`),
				content: t(
					isMobile && i18n.exists(`${stop.i18nKey}_body_mobile`)
						? `${stop.i18nKey}_body_mobile`
						: `${stop.i18nKey}_body`
				),
			})),
		[t, i18n, isMobile]
	);

	/**
	 * Show step `index`: navigate to its page if needed and resume the tour only
	 * once the target exists. A fixed delay used to race page mount + data fetch,
	 * so Joyride hit TARGET_NOT_FOUND and silently skipped stops.
	 */
	const goTo = useCallback(
		(index: number) => {
			const stop = TOUR_STOPS[index];
			if (!stop) return;
			const token = ++goToken.current;
			const selector = targetOf(stop, window.matchMedia(MOBILE_QUERY).matches);
			setStepIndex(index);
			if (pathRef.current === stop.route && document.querySelector(selector)) {
				setRunning(true);
				return;
			}
			setRunning(false);
			if (pathRef.current !== stop.route) navigate(stop.route);
			void waitForTarget(selector).then(() => {
				if (goToken.current === token) setRunning(true);
			});
		},
		[navigate]
	);

	const start = useCallback(() => goTo(0), [goTo]);

	const stop = useCallback(() => {
		goToken.current++;
		setRunning(false);
	}, []);

	// Auto-start triggers. Deliberately no timer + cleanup: stripping the `tour`
	// param re-runs this effect, and that cleanup used to cancel the start.
	useEffect(() => {
		if (autoStartedRef.current) return;
		if (!me?.user) return;
		if (me.user.must_change_password) return;
		const tourParam = searchParams.get('tour');
		const wantsAuto = tourParam === 'auto' || tourParam === 'replay';
		const fromFlags =
			!me.flags?.tour_completed_at && !me.flags?.tour_dismissed && !!me.flags?.onboarding_completed_at;
		if (wantsAuto || fromFlags) {
			autoStartedRef.current = true;
			// Strip the param so a manual refresh doesn't re-trigger
			if (tourParam) {
				searchParams.delete('tour');
				setSearchParams(searchParams, { replace: true });
			}
			start();
		}
	}, [me, searchParams, setSearchParams, start]);

	const onCallback = useCallback(
		(data: CallBackProps) => {
			const { action, index, status, type } = data;

			// Tour finished or user clicked Skip / closed
			if (status === STATUS.FINISHED) {
				stop();
				void patchFlags.mutateAsync({ tour_completed_at: new Date().toISOString() });
				return;
			}
			if (status === STATUS.SKIPPED || action === ACTIONS.CLOSE) {
				stop();
				void patchFlags.mutateAsync({ tour_dismissed: true });
				return;
			}

			// Step finished (or its target never appeared) — move on, navigating if needed
			if (type === EVENTS.STEP_AFTER || type === EVENTS.TARGET_NOT_FOUND) {
				const nextIndex = action === ACTIONS.PREV ? index - 1 : index + 1;
				if (nextIndex >= TOUR_STOPS.length) {
					stop();
					void patchFlags.mutateAsync({ tour_completed_at: new Date().toISOString() });
					return;
				}
				if (nextIndex >= 0) goTo(nextIndex);
			}
		},
		[goTo, stop, patchFlags]
	);

	const ctx = useMemo<AppTourContextValue>(() => ({ running, start, stop }), [running, start, stop]);

	// Joyride paints its arrow as an SVG fill, where CSS variables don't resolve — use concrete colours
	const surface = scheme === 'dark' ? '#242424' : '#ffffff';
	const text = scheme === 'dark' ? '#c9c9c9' : '#000000';
	const dimmed = scheme === 'dark' ? '#828282' : '#868e96';

	return (
		<AppTourContext.Provider value={ctx}>
			{children}
			<Joyride
				steps={steps}
				run={running}
				stepIndex={stepIndex}
				continuous
				showProgress
				showSkipButton
				disableOverlayClose
				scrollToFirstStep
				scrollOffset={isMobile ? 76 : 96}
				callback={onCallback}
				styles={{
					options: {
						primaryColor: '#ff7030',
						zIndex: 10000,
						width: isMobile ? 'calc(100vw - 32px)' : 380,
						arrowColor: surface,
						backgroundColor: surface,
						textColor: text,
						overlayColor: 'rgba(0, 0, 0, 0.55)',
					},
					tooltip: {
						borderRadius: 8,
						padding: 16,
						border: '1px solid var(--mantine-color-default-border)',
						boxShadow: 'var(--cg-shadow-surface)',
						fontFamily: 'inherit',
					},
					tooltipTitle: {
						fontSize: 18,
						fontWeight: 700,
						textAlign: 'left',
						margin: 0,
						paddingRight: 24,
					},
					tooltipContent: {
						fontSize: 14,
						lineHeight: 1.55,
						textAlign: 'left',
						padding: '10px 0 4px',
					},
					tooltipFooter: {
						marginTop: 12,
					},
					buttonNext: {
						borderRadius: 8,
						backgroundColor: 'var(--mantine-primary-color-filled)',
						boxShadow: 'var(--cg-shadow-surface)',
						fontSize: 14,
						fontWeight: 600,
						padding: '8px 14px',
						fontFamily: 'inherit',
					},
					buttonBack: {
						color: text,
						fontSize: 14,
						fontWeight: 600,
						marginRight: 4,
						fontFamily: 'inherit',
					},
					buttonSkip: {
						color: dimmed,
						fontSize: 13,
						paddingLeft: 0,
						fontFamily: 'inherit',
					},
					buttonClose: {
						color: dimmed,
					},
					spotlight: {
						borderRadius: 8,
					},
				}}
				locale={{
					back: t('tour.back'),
					close: t('tour.close'),
					last: t('tour.last'),
					next: t('tour.next'),
					// Replaces `next` while showProgress is on — untranslated, it showed English buttons
					nextLabelWithProgress: t('tour.next_progress', { defaultValue: t('tour.next') }),
					skip: t('tour.skip'),
				}}
			/>
		</AppTourContext.Provider>
	);
}
