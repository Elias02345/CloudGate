/**
 * Which layout a device gets.
 *
 * Mouse/trackpad devices switch to the phone layout below 768px. Touch-only
 * devices (no hover, coarse pointer: tablets, unfolded foldables) keep the
 * phone layout up to 1200px — the desktop layout technically fits there, but
 * dense tables and the floating sidebar break down at that size by finger.
 *
 * The theme's `sm` breakpoint and `useMediaQuery` calls read from here;
 * `styles/global.css` repeats the same rule in its media queries.
 */

const TOUCH_ONLY =
	typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Upper edge of the phone layout, as used by Mantine's `sm` breakpoint. */
export const MOBILE_BREAKPOINT = TOUCH_ONLY ? '75em' : '48em';

/** Matches while the phone layout is active. */
export const MOBILE_QUERY = TOUCH_ONLY ? '(max-width: 74.99em)' : '(max-width: 47.99em)';
