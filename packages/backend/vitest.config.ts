import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			exclude: ['node_modules', 'dist', '**/*.test.ts'],
		},
	},
	resolve: {
		alias: {
			'@cloudgate/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
		},
	},
});
