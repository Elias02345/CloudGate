/**
 * Cloudy — CloudGate's mascot: a small cloud with arms and legs.
 *
 * Shared contract between the figure (Cloudy.tsx, pure SVG + CSS animation)
 * and the stage that walks it across the UI (CloudyStage.tsx / useCloudy).
 */

import type { ReactNode } from 'react';

/** What Cloudy is doing. Each pose has its own looping or one-shot animation. */
export type CloudyPose =
	/** Standing, breathing, blinking. */
	| 'idle'
	/** Legs and arms swing, body bobs — used while moving across the screen. */
	| 'walk'
	/** Waves one arm; greeting and goodbye. */
	| 'wave'
	/** Points ahead at whatever he stands next to. */
	| 'point'
	/** Busy: taps away at the thing in front of him while a task runs. */
	| 'work'
	/** Little jump of joy when a task finished. */
	| 'cheer'
	/** Eyes closed, gentle drift — when nothing is going on. */
	| 'sleep';

export interface CloudyProps {
	pose?: CloudyPose;
	/** Which way he looks; the figure mirrors itself. */
	facing?: 'left' | 'right';
	/** Rendered height in px (width follows). Default 64. */
	size?: number;
	/** Small sign held up with one arm — an emoji or tiny node (e.g. a heart). */
	sign?: ReactNode;
	className?: string;
	/** Title for assistive tech; omit for a purely decorative appearance. */
	label?: string;
}
