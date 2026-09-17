import type { CSSProperties } from 'react';
import type { CloudyProps } from './types';
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

/** Cloudy — CloudGate's mascot. Pure SVG geometry; every animation lives in cloudy.css, driven by [data-pose]. */
export function Cloudy({ pose = 'idle', facing = 'right', size = 64, sign, className, label }: CloudyProps) {
	const hasSign = sign != null;
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
				</g>
				<path className="cg-cloudy__mouth" d="M 50,66 Q 60,73 70,66" />

				{/* zzz, sleep-only (hidden elsewhere by CSS); counter-mirrored so the glyphs never flip */}
				<g style={unmirror}>
					<text className="cg-cloudy__z cg-cloudy__z--a" x="90" y="24">
						z
					</text>
					<text className="cg-cloudy__z cg-cloudy__z--b" x="100" y="12">
						z
					</text>
				</g>

				{hasSign && (
					<g className="cg-cloudy__sign">
						<rect x="82" y="15" width="32" height="22" rx="6" />
						<foreignObject x="86" y="19" width="24" height="14">
							{/* spread avoids the DOM typings' missing `xmlns`, required for cross-browser foreignObject content */}
							<div {...{ xmlns: 'http://www.w3.org/1999/xhtml' }} style={{ ...signBoxStyle, ...unmirrorBox }}>
								{sign}
							</div>
						</foreignObject>
					</g>
				)}
			</g>
		</svg>
	);
}
