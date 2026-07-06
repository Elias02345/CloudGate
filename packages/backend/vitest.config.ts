import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
		setupFiles: ['./tests/setup.ts'],
		// knex imports migration .ts files natively (outside vitest's
		// transformer). The tsx loader makes that work on Windows too.
		poolOptions: { forks: { execArgv: ['--import', 'tsx'] } },
		// Bootstrap-in-beforeAll suites run real migrations + argon2; give
		// slower/Windows dev machines headroom over the default 10s/5s.
		hookTimeout: 30_000,
		testTimeout: 20_000,
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
