import type { CSSProperties, ReactNode } from 'react';
import type { CloudyProps, CloudySign } from './types';
import './cloudy.css';

// Fixed square canvas so every pose/size scales cleanly; geometry below is hand-tuned to it.
const VIEWBOX = '0 0 120 120';

// Inner content that must never read backwards when the figure is mirrored (facing: 'left').
const unmirrorSvg: CSSProperties = {
	transform: 'scaleX(-1)',
	transformBox: 'fill-box',
	transformOrigin: 'center',
};
const unmirrorHtml: CSSProperties = { transform: 'scaleX(-1)' };
const signBoxStyle: CSSProperties = {
	width: '100%',
	height: '100%',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontSize: 10,
	lineHeight: 1,
	overflow: 'hidden',
};

const SIGN_NAMES = new Set<string>(['heart', 'star', 'check', 'question', 'alert', 'sparkle']);
function isNamedSign(sign: CloudyProps['sign']): sign is CloudySign {
	return typeof sign === 'string' && SIGN_NAMES.has(sign);
}

// Symbol geometry, centered on the sign plate (rect cx=98, cy=26). Colour comes from CSS
// (fill/stroke inherit from the wrapping .cg-cloudy__sign-icon--<name> group) so both schemes work.
const SIGN_SYMBOL_CONTENT: Record<CloudySign, ReactNode> = {
	heart: (
		<path d="M 98,32 C 90,25 90,19 95,19 C 97,19 98,21 98,22 C 98,21 99,19 101,19 C 106,19 106,25 98,32 Z" />
	),
	star: (
		<path d="M 98,18 L 99.9,23.4 L 105.6,23.5 L 101,27 L 102.7,32.5 L 98,29.2 L 93.3,32.5 L 95,27 L 90.4,23.5 L 96.1,23.4 Z" />
	),
	check: <path d="M 90,26 L 96,32 L 107,19" />,
	question: (
		<>
			<path d="M 92,21 C 92,16 104,16 104,22 C 104,26 98,26 98,30" />
			<circle cx="98" cy="34" r="1.8" />
		</>
	),
	alert: (
		<>
			<path d="M 98,17 L 108,34 L 88,34 Z" />
			<line x1="98" y1="22" x2="98" y2="28" />
			<circle cx="98" cy="31" r="1.3" />
		</>
	),
	sparkle: (
		<path d="M 98,17 C 99,23 101,25 107,26 C 101,27 99,29 98,35 C 97,29 95,27 89,26 C 95,25 97,23 98,17 Z" />
	),
};

/** Cloudy — CloudGate's mascot. Pure SVG geometry; every animation lives in cloudy.css, driven by [data-pose]. */
export function Cloudy({ pose = 'idle', facing = 'right', size = 64, sign, className, label }: CloudyProps) {
	const hasSign = sign != null;
	const namedSign = isNamedSign(sign) ? sign : undefined;
	const unmirror = facing === 'left' ? unmirrorSvg : undefined;
	const unmirrorBox = facing === 'left' ? unmirrorHtml : undefined;

	return (
		<svg
			className={className ? `cg-cloudy ${className}` : 'cg-cloudy'}
			data-pose={pose}
			data-facing={facing}
			width={size}
			height={size}
			viewBox={VIEWBOX}
			role={label ? 'img' : 'presentation'}
			aria-hidden={label ? undefined : true}
		>
			{label ? <title>{label}</title> : null}
			<g className="cg-cloudy__figure">
				{/* body: 5-arc silhouette, symmetric around x=60, flat baseline y=90 for hips */}
				<path
					className="cg-cloudy__body"
					d="M 34,90 A 20,20 0 0 1 16,62 A 20,20 0 0 1 34,34 A 28,28 0 0 1 86,34 A 20,20 0 0 1 104,62 A 20,20 0 0 1 86,90 Z"
				/>

				{/*
				 * Limbs: the outer <g> carries the joint position, the inner one the pose
				 * animation — a pose's CSS transform replaces the transform attribute, so
				 * position and rotation must not live on the same element.
				 */}
				<g transform="translate(46,90)">
					<g className="cg-cloudy__leg-left">
						<line x1="0" y1="0" x2="0" y2="18" />
						<circle cx="0" cy="18" r="6" />
					</g>
				</g>
				<g transform="translate(74,90)">
					<g className="cg-cloudy__leg-right">
						<line x1="0" y1="0" x2="0" y2="18" />
						<circle cx="0" cy="18" r="6" />
					</g>
				</g>

				<g transform="translate(24,64)">
					<g className="cg-cloudy__arm-left">
						<line x1="0" y1="0" x2="0" y2="26" />
						<circle cx="0" cy="26" r="5" />
					</g>
				</g>
				{hasSign ? (
					// holding the sign: arm drawn straight up, angled outward via a static CSS rule
					<g transform="translate(96,64)">
						<g className="cg-cloudy__arm-right cg-cloudy__arm-right--raised">
							<line x1="0" y1="0" x2="0" y2="-30" />
							<circle cx="0" cy="-30" r="5" />
						</g>
					</g>
				) : (
					<g transform="translate(96,64)">
						<g className="cg-cloudy__arm-right">
							<line x1="0" y1="0" x2="0" y2="26" />
							<circle cx="0" cy="26" r="5" />
						</g>
					</g>
				)}

				{/* face */}
				<circle className="cg-cloudy__cheek" cx="38" cy="68" r="4" />
				<circle className="cg-cloudy__cheek" cx="82" cy="68" r="4" />
				<g className="cg-cloudy__eyes">
					<circle className="cg-cloudy__eye" cx="46" cy="56" r="5" />
					<circle className="cg-cloudy__eye" cx="74" cy="56" r="5" />
					<rect className="cg-cloudy__eye-lid" x="40" y="50" width="12" height="12" rx="6" />
					<rect className="cg-cloudy__eye-lid" x="68" y="50" width="12" height="12" rx="6" />
					{/* love-only: heart eyes, hidden unless data-pose="love" */}
					<path
						className="cg-cloudy__eye-heart"
						d="M 46,61 C 40,56 40,52 43.5,52 C 45,52 46,53 46,54 C 46,53 47,52 48.5,52 C 52,52 52,56 46,61 Z"
					/>
					<path
						className="cg-cloudy__eye-heart"
						d="M 74,61 C 68,56 68,52 71.5,52 C 73,52 74,53 74,54 C 74,53 75,52 76.5,52 C 80,52 80,56 74,61 Z"
					/>
				</g>
				<path className="cg-cloudy__mouth" d="M 50,66 Q 60,73 70,66" />
				{/* yawn-only: open mouth, swapped in via opacity so the resting look is a real ellipse, not a font glyph */}
				<ellipse className="cg-cloudy__mouth-yawn" cx="60" cy="70" rx="8" ry="7" />

				{/* above-head decorations, hidden unless their pose is active; counter-mirrored so glyphs never flip */}
				<g style={unmirror}>
					{/* zzz, sleep-only */}
					<text className="cg-cloudy__z cg-cloudy__z--a" x="90" y="24">
						z
					</text>
					<text className="cg-cloudy__z cg-cloudy__z--b" x="100" y="12">
						z
					</text>

					{/* think-only: trailing dots */}
					<circle className="cg-cloudy__think-dot cg-cloudy__think-dot--1" cx="88" cy="22" r="1.8" />
					<circle className="cg-cloudy__think-dot cg-cloudy__think-dot--2" cx="94" cy="17" r="1.5" />
					<circle className="cg-cloudy__think-dot cg-cloudy__think-dot--3" cx="99" cy="13" r="1.2" />

					{/* confused-only: popping question mark */}
					<g className="cg-cloudy__confused-q">
						<path d="M 88,16 C 88,12 96,12 96,17 C 96,20 92,20 92,23" />
						<circle cx="92" cy="27" r="1.4" />
					</g>

					{/* love-only: drifting hearts */}
					<path
						className="cg-cloudy__heart-float cg-cloudy__heart-float--a"
						d="M 28,38 C 23.5,34.5 23.5,31.5 26,31.5 C 27.2,31.5 28,32.2 28,33 C 28,32.2 28.8,31.5 30,31.5 C 32.5,31.5 32.5,34.5 28,38 Z"
					/>
					<path
						className="cg-cloudy__heart-float cg-cloudy__heart-float--b"
						d="M 92,34 C 87.5,30.5 87.5,27.5 90,27.5 C 91.2,27.5 92,28.2 92,29 C 92,28.2 92.8,27.5 94,27.5 C 96.5,27.5 96.5,30.5 92,34 Z"
					/>
				</g>

				{hasSign && (
					<g className="cg-cloudy__sign">
						<rect x="82" y="15" width="32" height="22" rx="6" />
						{namedSign ? (
							<g className={`cg-cloudy__sign-icon cg-cloudy__sign-icon--${namedSign}`} style={unmirror}>
								{SIGN_SYMBOL_CONTENT[namedSign]}
							</g>
						) : (
							<foreignObject x="86" y="19" width="24" height="14">
								{/* spread avoids the DOM typings' missing `xmlns`, required for cross-browser foreignObject content */}
								<div
									{...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
									style={{ ...signBoxStyle, ...unmirrorBox }}
								>
									{sign}
								</div>
							</foreignObject>
						)}
					</g>
				)}
			</g>
		</svg>
	);
}
