/**
 * App-wide guided tour using react-joyride.
 *
 * Behaviour:
 *   - <AppTourProvider> wraps the app. Reads `flags` from /me and decides
 *     whether to auto-start (after onboarding, when tour_completed_at is null
 *     and tour_dismissed is false).
 *   - Also auto-starts when URL contains `?tour=auto` or `?tour=replay`.
 *   - Cross-page navigation: each TourStop knows its `route`; the callback
 *     navigates before showing the spotlight.
 *   - Persistence: skip → tour_dismissed = true, finish → tour_completed_at.
 *
 * The `useAppTour()` hook lets any component start/stop the tour
 * (e.g. Settings replay button).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Joyride, { ACTIONS, EVENTS, STATUS, type CallBackProps, type Step } from 'react-joyride';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe, usePatchUserFlags } from '../api/auth.js';
import { TOUR_STOPS } from './tour/tour-steps.js';

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

export function AppTourProvider({ children }: { children: React.ReactNode }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: me } = useMe();
	const patchFlags = usePatchUserFlags();

	const [running, setRunning] = useState(false);
	const [stepIndex, setStepIndex] = useState(0);
	const autoStartedRef = useRef(false);

	// Build the Joyride step array from TOUR_STOPS + i18n. Re-runs on language
	// change because `t` updates.
	const steps: Step[] = useMemo(
		() =>
			TOUR_STOPS.map((stop) => ({
				target: stop.target,
				placement: stop.placement,
				disableBeacon: stop.disableBeacon,
				title: t(`${stop.i18nKey}_title`),
				content: t(`${stop.i18nKey}_body`),
			})),
		[t]
	);

	const start = useCallback(() => {
		setStepIndex(0);
		setRunning(true);
		// Make sure we're on the first stop's route before showing
		const first = TOUR_STOPS[0]!;
		if (location.pathname !== first.route) {
			navigate(first.route);
		}
	}, [location.pathname, navigate]);

	const stop = useCallback(() => {
		setRunning(false);
	}, []);

	// Auto-start triggers
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
			// small delay so the page mounts and `data-tour` targets exist
			const timer = setTimeout(start, 600);
			return () => clearTimeout(timer);
		}
	}, [me, searchParams, setSearchParams, start]);

	const onCallback = useCallback(
		(data: CallBackProps) => {
			const { action, index, status, type } = data;

			// Tour finished or user clicked Skip / closed
			if (status === STATUS.FINISHED) {
				setRunning(false);
				void patchFlags.mutateAsync({ tour_completed_at: new Date().toISOString() });
				return;
			}
			if (status === STATUS.SKIPPED || action === ACTIONS.CLOSE) {
				setRunning(false);
				void patchFlags.mutateAsync({ tour_dismissed: true });
				return;
			}

			// Step finished — advance & navigate to next route if needed
			if (type === EVENTS.STEP_AFTER || type === EVENTS.TARGET_NOT_FOUND) {
				const nextIndex = action === ACTIONS.PREV ? index - 1 : index + 1;
				if (nextIndex < 0 || nextIndex >= TOUR_STOPS.length) return;
				const nextStop = TOUR_STOPS[nextIndex]!;
				if (location.pathname !== nextStop.route) {
					// Pause the tour briefly while navigating
					setRunning(false);
					navigate(nextStop.route);
					setStepIndex(nextIndex);
					setTimeout(() => setRunning(true), 350);
				} else {
					setStepIndex(nextIndex);
				}
			}
		},
		[location.pathname, navigate, patchFlags]
	);

	const ctx = useMemo<AppTourContextValue>(() => ({ running, start, stop }), [running, start, stop]);

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
				callback={onCallback}
				styles={{
					options: {
						primaryColor: '#ff6620',
						zIndex: 10000,
						arrowColor: 'var(--mantine-color-body)',
						backgroundColor: 'var(--mantine-color-body)',
						textColor: 'var(--mantine-color-text)',
						overlayColor: 'rgba(0, 0, 0, 0.55)',
					},
					tooltip: {
						borderRadius: 8,
					},
					buttonNext: {
						borderRadius: 6,
						backgroundColor: '#ff6620',
					},
					buttonBack: {
						color: 'var(--mantine-color-text)',
					},
				}}
				locale={{
					back: t('tour.back'),
					close: t('tour.close'),
					last: t('tour.last'),
					next: t('tour.next'),
					skip: t('tour.skip'),
				}}
			/>
		</AppTourContext.Provider>
	);
}
