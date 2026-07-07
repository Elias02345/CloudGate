/**
 * Global test setup (runs before every suite).
 *
 * Skip the Playit binary download that bootstrap would otherwise do on each
 * run. No test needs the real binary — playit-provider.test.ts mocks the REST
 * client, and every other suite only touches the DB. The network fetch made
 * the bootstrap-in-beforeAll suites slow and flaky (and unrunnable offline).
 */
process.env.CLOUDGATE_PLAYIT_ENABLED = 'false';
