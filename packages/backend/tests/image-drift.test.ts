/**
 * Detection of fixes the self-updater cannot deliver.
 *
 * The release tarball holds only backend/, frontend/ and recovery-ui/, and
 * apply-update.sh swaps exactly those. Everything else — the nginx configs,
 * the s6 service scripts, bootstrap.sh, apply-update.sh itself — lives in the
 * container image and is untouched by an update from the UI.
 *
 * That matters most for one change: 0.3.2 removed the `/__recovery/` proxy,
 * which forwarded to a service with no authentication of its own. An
 * installation that only ever self-updates runs the fixed application behind
 * the unfixed proxy and is still exposed, while its version number says
 * otherwise. This check is what tells the operator to pull an image.
 *
 * The real nginx config is asserted against too, so the day someone
 * reintroduces that block the test fails rather than the detector.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { driftProblemsInNginxConf } from '../src/services/image-drift.js';

const VULNERABLE_CONF = `
server {
	listen 80 default_server;
	location /api/ {
		proxy_pass http://127.0.0.1:3000;
	}

	# Recovery UI accessible via /__recovery (handy even on healthy systems)
	location /__recovery/ {
		proxy_pass http://127.0.0.1:8001/;
	}
}
`;

describe('driftProblemsInNginxConf', () => {
	it('flags an image that still proxies /__recovery/', () => {
		const problems = driftProblemsInNginxConf(VULNERABLE_CONF);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('/__recovery/');
		// The operator needs to be told what to actually do about it.
		expect(problems[0]).toContain('docker compose pull');
	});

	it('says nothing about a config without that block', () => {
		const fixed = VULNERABLE_CONF.replace(/\n\t# Recovery[\s\S]*?\n\t\}\n/, '\n');
		expect(fixed).not.toContain('__recovery');
		expect(driftProblemsInNginxConf(fixed)).toEqual([]);
	});

	it('is not fooled by the word appearing in a comment only', () => {
		const commentOnly = '# never proxy /__recovery/ from normal mode\nserver { listen 80; }\n';
		expect(driftProblemsInNginxConf(commentOnly)).toEqual([]);
	});

	it("the repository's own normal-mode config is clean", () => {
		// Guards the fix itself: reintroducing the block fails here.
		const conf = readFileSync(
			fileURLToPath(new URL('../../../docker/nginx/cloudgate.conf', import.meta.url)),
			'utf8'
		);
		expect(driftProblemsInNginxConf(conf)).toEqual([]);
	});
});
