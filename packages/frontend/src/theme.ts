/**
 * CloudGate Mantine theme — brand colors + small UX defaults.
 */

import { createTheme, type MantineColorsTuple } from '@mantine/core';

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
	fontFamily:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
	defaultRadius: 'md',
	components: {
		Card: {
			defaultProps: {
				shadow: 'sm',
			},
		},
		Button: {
			defaultProps: {
				radius: 'md',
			},
		},
	},
});
