/**
 * Spotlight tour stops — 12 stops covering all main pages.
 *
 * Each stop names the page (for cross-page navigation) and a CSS selector
 * for the spotlight target. The target element should have a
 * `data-tour="<id>"` attribute, which is more stable than relying on text
 * content or DOM structure.
 *
 * Translation keys live under `tour.stop_<N>_title` and `tour.stop_<N>_body`.
 */

import type { Placement } from 'react-joyride';

/**
 * One stop in the guided app tour. `target` is a CSS selector pointing to a
 * `data-tour="..."` attribute on the page identified by `route`. The actual
 * Joyride `Step` (with translated title + content) is built at runtime in
 * AppTour.tsx using `i18nKey` as the lookup prefix.
 */
export interface TourStop {
	/** Route to navigate to before showing this step. */
	route: string;
	/** Translation key prefix (e.g. `tour.stop_4`). */
	i18nKey: string;
	/** CSS selector pointing to the spotlight target element. */
	target: string;
	/** Optional preferred placement. */
	placement?: Placement;
	/** Whether to skip the beacon "pulse" before the tooltip shows. */
	disableBeacon?: boolean;
}

export const TOUR_STOPS: TourStop[] = [
	{
		route: '/',
		i18nKey: 'tour.stop_1',
		target: '[data-tour="app-logo"]',
		placement: 'bottom-start',
		disableBeacon: true,
	},
	{
		route: '/',
		i18nKey: 'tour.stop_2',
		target: '[data-tour="dashboard-health"]',
		placement: 'bottom',
	},
	{
		route: '/',
		i18nKey: 'tour.stop_3',
		target: '[data-tour="sidebar-nav"]',
		placement: 'right',
	},
	{
		route: '/hosts',
		i18nKey: 'tour.stop_4',
		target: '[data-tour="hosts-add-btn"]',
		placement: 'bottom',
	},
	{
		route: '/hosts',
		i18nKey: 'tour.stop_5',
		target: '[data-tour="hosts-mode-switch"]',
		placement: 'bottom',
	},
	{
		route: '/tunnels',
		i18nKey: 'tour.stop_6',
		target: '[data-tour="tunnels-list"]',
		placement: 'bottom',
	},
	{
		route: '/cloudflare',
		i18nKey: 'tour.stop_7',
		target: '[data-tour="cloudflare-accounts"]',
		placement: 'bottom',
	},
	{
		route: '/settings',
		i18nKey: 'tour.stop_8',
		target: '[data-tour="settings-2fa"]',
		placement: 'top',
	},
	{
		route: '/settings',
		i18nKey: 'tour.stop_9',
		target: '[data-tour="settings-backup"]',
		placement: 'top',
	},
	{
		route: '/audit',
		i18nKey: 'tour.stop_10',
		target: '[data-tour="audit-filters"]',
		placement: 'bottom',
	},
	{
		route: '/updates',
		i18nKey: 'tour.stop_11',
		target: '[data-tour="updates-status"]',
		placement: 'bottom',
	},
	{
		route: '/donate',
		i18nKey: 'tour.stop_12',
		target: '[data-tour="donate-cards"]',
		placement: 'top',
	},
];
