import './animations.css';

const ORANGE = '#ff6620';
const ORANGE_LIGHT = '#ffb38f';
const CYAN = '#22d3ee';
const GREEN = '#22c55e';
const SLATE = '#94a3b8';

interface AnimProps {
	size?: number;
}

/** Welcome — cloud + animated arrows pointing to a home/server box. */
export function WelcomeAnim({ size = 200 }: AnimProps) {
	return (
		<svg width={size} height={size * 0.6} viewBox="0 0 200 120" aria-hidden="true" role="presentation">
			<g className="cg-anim-pulse">
				<ellipse cx="50" cy="40" rx="30" ry="18" fill={ORANGE_LIGHT} opacity="0.4" />
				<ellipse cx="50" cy="38" rx="24" ry="14" fill={ORANGE} />
				<text x="50" y="42" textAnchor="middle" fill="white" fontSize="10" fontWeight="700">
					CF
				</text>
			</g>
			<g>
				<path
					d="M 80 60 L 120 60"
					stroke={ORANGE}
					strokeWidth="2"
					fill="none"
					strokeLinecap="round"
					markerEnd="url(#arrowhead)"
					className="cg-anim-arrow"
				/>
				<path
					d="M 80 60 L 120 60"
					stroke={ORANGE_LIGHT}
					strokeWidth="2"
					fill="none"
					strokeLinecap="round"
					markerEnd="url(#arrowhead)"
					className="cg-anim-arrow cg-anim-arrow-delay"
				/>
			</g>
			<g>
				<rect x="140" y="40" width="44" height="44" rx="6" fill="none" stroke={SLATE} strokeWidth="2" />
				<rect x="146" y="48" width="32" height="3" fill={SLATE} />
				<rect x="146" y="55" width="20" height="3" fill={SLATE} />
				<rect x="146" y="62" width="26" height="3" fill={SLATE} />
				<circle cx="170" cy="76" r="2.5" fill={GREEN} className="cg-anim-pulse" />
			</g>
			<defs>
				<marker id="arrowhead" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
					<polygon points="0 0, 6 3, 0 6" fill={ORANGE} />
				</marker>
			</defs>
		</svg>
	);
}

/** Cloudflare — a key gliding into a CF-shaped logo. */
export function CloudflareAnim({ size = 200 }: AnimProps) {
	return (
		<svg width={size} height={size * 0.6} viewBox="0 0 200 120" aria-hidden="true" role="presentation">
			<g className="cg-anim-pulse" style={{ animationDuration: '3s' }}>
				<path
					d="M 100 80 Q 80 80 80 60 Q 80 40 100 40 Q 120 40 130 50 Q 140 40 150 50 Q 160 60 150 75 Z"
					fill={ORANGE}
				/>
			</g>
			<g className="cg-anim-key">
				<circle
					cx="0"
					cy="0"
					r="6"
					fill="none"
					stroke="#fbbf24"
					strokeWidth="2.5"
					transform="translate(60 60)"
				/>
				<rect x="64" y="58" width="14" height="4" fill="#fbbf24" />
				<rect x="74" y="62" width="3" height="4" fill="#fbbf24" />
			</g>
		</svg>
	);
}

/** Tunnel — animated dashed line representing data flowing through. */
export function TunnelAnim({ size = 200 }: AnimProps) {
	return (
		<svg width={size} height={size * 0.6} viewBox="0 0 200 120" aria-hidden="true" role="presentation">
			<rect x="20" y="50" width="40" height="20" rx="4" fill={SLATE} opacity="0.6" />
			<text x="40" y="64" textAnchor="middle" fill="white" fontSize="8" fontWeight="600">
				HOME
			</text>
			<rect x="140" y="50" width="40" height="20" rx="4" fill={ORANGE} />
			<text x="160" y="64" textAnchor="middle" fill="white" fontSize="8" fontWeight="600">
				CF
			</text>
			<path
				d="M 60 60 L 140 60"
				stroke={CYAN}
				strokeWidth="3"
				strokeLinecap="round"
				className="cg-anim-tunnel"
				fill="none"
			/>
			<circle cx="100" cy="60" r="4" fill={ORANGE}>
				<animate attributeName="cx" from="60" to="140" dur="1.4s" repeatCount="indefinite" />
			</circle>
		</svg>
	);
}

/** First-host — server icon with animated green checkmark. */
export function FirstHostAnim({ size = 200 }: AnimProps) {
	return (
		<svg width={size} height={size * 0.6} viewBox="0 0 200 120" aria-hidden="true" role="presentation">
			<rect x="60" y="30" width="80" height="60" rx="6" fill="none" stroke={SLATE} strokeWidth="2" />
			<rect x="68" y="40" width="64" height="6" rx="2" fill={SLATE} opacity="0.6" />
			<rect x="68" y="50" width="48" height="6" rx="2" fill={SLATE} opacity="0.6" />
			<rect x="68" y="60" width="56" height="6" rx="2" fill={SLATE} opacity="0.6" />
			<rect x="68" y="70" width="40" height="6" rx="2" fill={SLATE} opacity="0.6" />
			<circle cx="155" cy="80" r="18" fill={GREEN} className="cg-anim-bounce" />
			<path
				d="M 146 80 L 153 87 L 165 73"
				stroke="white"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
				className="cg-anim-check"
			/>
		</svg>
	);
}

/** Verification — generic "checking" spinner. */
export function VerifyAnim({ size = 60 }: AnimProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 60 60" aria-hidden="true" role="presentation">
			<circle cx="30" cy="30" r="22" fill="none" stroke={SLATE} strokeWidth="3" opacity="0.25" />
			<circle
				cx="30"
				cy="30"
				r="22"
				fill="none"
				stroke={ORANGE}
				strokeWidth="3"
				strokeLinecap="round"
				strokeDasharray="60 200"
				className="cg-anim-spin"
			/>
		</svg>
	);
}

/** Done — confetti burst with checkmark. */
export function DoneAnim({ size = 200 }: AnimProps) {
	const confetti = [
		{ id: 'c0', left: '20%', bg: ORANGE, delay: '0s' },
		{ id: 'c1', left: '35%', bg: '#22d3ee', delay: '0.15s' },
		{ id: 'c2', left: '50%', bg: '#fbbf24', delay: '0.05s' },
		{ id: 'c3', left: '65%', bg: GREEN, delay: '0.25s' },
		{ id: 'c4', left: '80%', bg: '#a78bfa', delay: '0.1s' },
	];
	return (
		<div style={{ position: 'relative', width: size, height: size * 0.6, marginInline: 'auto' }}>
			{confetti.map((c) => (
				<span
					key={c.id}
					className="cg-confetti"
					style={{ left: c.left, top: '70%', background: c.bg, animationDelay: c.delay }}
				/>
			))}
			<svg
				width={size}
				height={size * 0.6}
				viewBox="0 0 200 120"
				aria-hidden="true"
				role="presentation"
				style={{ position: 'absolute', inset: 0 }}
			>
				<circle cx="100" cy="60" r="30" fill={GREEN} className="cg-anim-bounce" />
				<path
					d="M 86 62 L 96 72 L 116 50"
					stroke="white"
					strokeWidth="4"
					strokeLinecap="round"
					strokeLinejoin="round"
					fill="none"
					className="cg-anim-check"
				/>
			</svg>
		</div>
	);
}
