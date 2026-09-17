/**
 * CloudGate Mantine theme — brand colors + small UX defaults.
 */

import { type MantineColorsTuple, createTheme } from '@mantine/core';

// CloudGate orange — accents on logo, primary buttons, badges
const cgOrange: MantineColorsTuple = [
	'#fff4ed',
	'#ffe2d2',
	'#ffc2a5',
	'#ffa074',
	'#ff834a',
	'#ff7030',
	'#ff6620',
	'#e35714',
	'#cb4d0e',
	'#b14108',
];

export const theme = createTheme({
	primaryColor: 'cg-orange',
	primaryShade: { light: 6, dark: 5 },
	colors: {
		'cg-orange': cgOrange,
	},
	fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
	defaultRadius: 'md',
	// Surface shadow from the Penpot design; per-component shadows live in styles/global.css
	shadows: {
		xs: '4px 4px 4px 0 rgba(0, 0, 0, 0.05)',
		sm: '4px 4px 4px 0 rgba(0, 0, 0, 0.2)',
		md: '4px 4px 4px 0 rgba(0, 0, 0, 0.2)',
	},
	components: {
		Card: {
			defaultProps: {
				shadow: 'sm',
				withBorder: true,
			},
		},
		// Native overflow: no reserved scrollbar gutter under tables on desktop
		TableScrollContainer: {
			defaultProps: {
				type: 'native',
			},
		},
		Button: {
			defaultProps: {
				radius: 'md',
			},
		},
	},
});
