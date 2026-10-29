/**
 * App-wide guided tour using react-joyride.
 *
 * Behaviour:
 *   - <AppTourProvider> wraps the app. Reads `flags` from /me and decides
 *     whether to auto-start (after onboarding, when tour_completed_at is null
 *     and tour_dismissed is false).
 *   - Also auto-starts when URL contains `?tour=auto` or `?tour=replay`.
 *   - Cross-page navigation: each TourStop knows its `route`; the step's
 *     `before` hook navigates there and waits until the target is rendered.
 *     A target that never appears is skipped by Joyride, in either direction.
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
import { ACTIONS, EVENTS, type EventData, Joyride, STATUS, type Step } from 'react-joyride';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe, usePatchUserFlags } from '../api/auth.js';
import { MOBILE_QUERY } from '../layout.js';
import { useCloudy } from './cloudy/useCloudy.js';
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

/**
 * Resolves once `selector` matches a rendered, non-empty element — or after
 * `timeoutMs` (Joyride then reports TARGET_NOT_FOUND). Kept below Joyride's
 * 5s `beforeTimeout`, which would otherwise abort the step.
 */
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
	const cloudy = useCloudy();

	const [running, setRunning] = useState(false);
	// Remounts Joyride so every start begins at the first stop
	const [runId, setRunId] = useState(0);
	const autoStartedRef = useRef(false);
	// Set once the tour ended, so the several end events only persist once
	const endedRef = useRef(false);
	// Read from the steps' async `before` hooks, which must not change identity mid-tour
	const pathRef = useRef(location.pathname);
	pathRef.current = location.pathname;
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	const cloudyRef = useRef(cloudy);
	cloudyRef.current = cloudy;

	// Build the Joyride step array from TOUR_STOPS + i18n. Re-runs on language
	// change because `t` updates.
	const steps: Step[] = useMemo(
		() =>
			TOUR_STOPS.map((stop) => {
				const selector = targetOf(stop, isMobile);
				return {
					target: selector,
					placement: isMobile ? 'auto' : stop.placement,
					title: t(`${stop.i18nKey}_title`),
					content: t(
						isMobile && i18n.exists(`${stop.i18nKey}_body_mobile`)
							? `${stop.i18nKey}_body_mobile`
							: `${stop.i18nKey}_body`
					),
					// Joyride holds the step until this resolves. A fixed delay used to
					// race page mount + data fetch, so stops were silently skipped.
					before: async () => {
						// Escape closes the step and Joyride moves on before the tour stops
						if (endedRef.current) return;
						if (pathRef.current !== stop.route) navigateRef.current(stop.route);
						await waitForTarget(selector);
						// Cloudy hosts the tour: he walks along and stands next to each stop
						void cloudyRef.current.walkTo(selector, { pose: 'point' });
					},
				};
			}),
		[t, i18n, isMobile]
	);

	const start = useCallback(() => {
		endedRef.current = false;
		setRunId((n) => n + 1);
		setRunning(true);
	}, []);

	const stop = useCallback(() => {
		setRunning(false);
		void cloudy.goHome();
	}, [cloudy]);

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

	const onEvent = useCallback(
		(data: EventData) => {
			const { action, status, type } = data;
			if (endedRef.current) return;

			// Last stop done (Joyride also finishes when the remaining targets are missing)
			if (status === STATUS.FINISHED) {
				endedRef.current = true;
				stop();
				void patchFlags.mutateAsync({ tour_completed_at: new Date().toISOString() });
				return;
			}
			// Skip button, the X (closeButtonAction 'skip') or Escape
			if (status === STATUS.SKIPPED || (type === EVENTS.STEP_AFTER && action === ACTIONS.CLOSE)) {
				endedRef.current = true;
				stop();
				void patchFlags.mutateAsync({ tour_dismissed: true });
			}
		},
		[stop, patchFlags]
	);

	// Joyride's overlay sits at 10000 — lift Cloudy above it while he hosts the tour
	useEffect(() => {
		const root = document.documentElement;
		if (running) root.style.setProperty('--cg-cloudy-z', '10001');
		else root.style.removeProperty('--cg-cloudy-z');
		return () => {
			root.style.removeProperty('--cg-cloudy-z');
		};
	}, [running]);

	const ctx = useMemo<AppTourContextValue>(() => ({ running, start, stop }), [running, start, stop]);

	// Joyride paints its arrow as an SVG fill, where CSS variables don't resolve — use concrete colours
	const surface = scheme === 'dark' ? '#242424' : '#ffffff';
	const text = scheme === 'dark' ? '#c9c9c9' : '#000000';
	const dimmed = scheme === 'dark' ? '#828282' : '#868e96';

	return (
		<AppTourContext.Provider value={ctx}>
			{children}
			<Joyride
				key={runId}
				steps={steps}
				run={running}
				continuous
				scrollToFirstStep
				onEvent={onEvent}
				options={{
					showProgress: true,
					skipBeacon: true,
					buttons: ['back', 'close', 'primary', 'skip'],
					// The X ends the tour (v3's default would advance a step)
					closeButtonAction: 'skip',
					overlayClickAction: false,
					scrollOffset: isMobile ? 76 : 96,
					primaryColor: '#ff7030',
					zIndex: 10000,
					width: isMobile ? 'calc(100vw - 32px)' : 380,
					arrowColor: surface,
					backgroundColor: surface,
					textColor: text,
					overlayColor: 'rgba(0, 0, 0, 0.55)',
					spotlightRadius: 8,
				}}
				styles={{
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
					buttonPrimary: {
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
				}}
				locale={{
					back: t('tour.back'),
					close: t('tour.close'),
					last: t('tour.last'),
					next: t('tour.next'),
					// Replaces `next` while showProgress is on — untranslated, it showed English buttons
					nextWithProgress: t('tour.next_progress', { defaultValue: t('tour.next') }),
					skip: t('tour.skip'),
				}}
			/>
		</AppTourContext.Provider>
	);
}
