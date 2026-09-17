/**
 * Tooltip that follows the pointer.
 *
 * Mantine's tooltip anchors to the element, so on small icon buttons the cursor
 * ends up sitting on top of the text. This one trails the pointer at an offset,
 * flips near the viewport edges, and keeps the deliberate open delay: it only
 * appears once someone hovers on purpose, not in passing.
 *
 * Drop-in for the `<Tooltip label=…>` usages of @mantine/core in this app.
 * Pointer-less devices (touch) get nothing — every wrapped control carries an
 * aria-label or title of its own.
 */

import { Portal } from '@mantine/core';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const OFFSET_X = 18;
const OFFSET_Y = 20;
const EDGE = 12;

interface TooltipProps {
	label: ReactNode;
	children: ReactNode;
	/** Milliseconds of intentional hovering before the label appears. */
	openDelay?: number;
	disabled?: boolean;
}

export function Tooltip({ label, children, openDelay = 500, disabled }: TooltipProps) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const boxRef = useRef<HTMLDivElement>(null);

	const clear = useCallback(() => {
		window.clearTimeout(timer.current);
		setPos(null);
	}, []);

	useEffect(() => () => window.clearTimeout(timer.current), []);

	const move = (e: React.PointerEvent) => {
		if (disabled || e.pointerType !== 'mouse') return;
		const next = { x: e.clientX, y: e.clientY };
		if (pos) {
			setPos(next);
			return;
		}
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setPos(next), openDelay);
	};

	// Keep the label fully on screen: flip to the other side of the cursor near an edge
	const box = boxRef.current?.getBoundingClientRect();
	const w = box?.width ?? 0;
	const h = box?.height ?? 0;
	const left = pos
		? pos.x + OFFSET_X + w > window.innerWidth - EDGE
			? pos.x - OFFSET_X - w
			: pos.x + OFFSET_X
		: 0;
	const top = pos
		? pos.y + OFFSET_Y + h > window.innerHeight - EDGE
			? pos.y - OFFSET_Y - h
			: pos.y + OFFSET_Y
		: 0;

	return (
		<>
			<span
				style={{ display: 'inline-flex', maxWidth: '100%' }}
				onPointerMove={move}
				onPointerLeave={clear}
				onPointerDown={clear}
			>
				{children}
			</span>
			{pos && (
				<Portal>
					<div
						ref={boxRef}
						className="cg-tooltip"
						style={{ left: Math.max(EDGE, left), top: Math.max(EDGE, top) }}
					>
						{label}
					</div>
				</Portal>
			)}
		</>
	);
}
