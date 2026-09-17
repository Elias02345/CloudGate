/**
 * Renders Cloudy at his current position/pose (state lives in useCloudy.tsx).
 * Mount this once near the app root, alongside <CloudyProvider>.
 */

import { useMediaQuery } from '@mantine/hooks';
import type { KeyboardEvent } from 'react';
import { MOBILE_QUERY } from '../../layout.js';
import { Cloudy } from './Cloudy.js';
import './stage.css';
import { DESKTOP_SIZE, MOBILE_SIZE, useCloudy, useCloudyRenderState } from './useCloudy.js';

const BUBBLE_WIDTH = 220;
const BUBBLE_GAP = 26; // bubble padding/border + the 10px offset in stage.css

export function CloudyStage() {
	const state = useCloudyRenderState();
	const cloudy = useCloudy();
	const isMobile = useMediaQuery(MOBILE_QUERY) ?? false;
	const size = isMobile ? MOBILE_SIZE : DESKTOP_SIZE;

	if (!state.visible) return null;

	const bubbleSide: 'left' | 'right' =
		state.x + size + BUBBLE_WIDTH + BUBBLE_GAP > window.innerWidth ? 'left' : 'right';

	const onDismiss = () => {
		if (state.dismissible) void cloudy.goHome();
	};
	const onDismissKey = (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') onDismiss();
	};
	// Only wired up as a button while the nudge is dismissible — during a guided
	// walk a stray tap on Cloudy shouldn't cancel it.
	const dismissProps = state.dismissible
		? { role: 'button' as const, tabIndex: 0, onClick: onDismiss, onKeyDown: onDismissKey }
		: {};

	return (
		<div className="cloudy-stage-layer">
			<div
				className="cloudy-figure-wrap"
				data-dismissible={state.dismissible}
				style={{
					transform: `translate3d(${state.x}px, ${state.y}px, 0)`,
					transitionDuration: `${state.durationMs}ms`,
				}}
				{...dismissProps}
			>
				<Cloudy pose={state.pose} facing={state.facing} size={size} sign={state.sign} />
				{state.bubble && (
					<div className="cloudy-bubble" data-side={bubbleSide} {...dismissProps}>
						{state.bubble}
					</div>
				)}
			</div>
		</div>
	);
}
