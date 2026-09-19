/**
 * Detection of fixes the self-updater cannot deliver.
 *
 * The release tarball holds only backend/, frontend/ and recovery-ui/, and
 * apply-update.sh swaps exactly those. Everything else — the nginx configs,
 * the s6 service scripts, bootstrap.sh, apply-update.sh itself — lives in the
 * container image and is untouched by an update from the UI.
 *
 * Two such changes are detected. 0.3.2 removed the `/__recovery/` proxy, which
 * forwarded to a service with no authentication of its own. 0.3.12 added the
 * security headers for the SPA's document, which nginx serves off disk where
 * helmet cannot reach it; without them the whole UI can be framed by any
 * origin while the operator's token sits in localStorage.
 *
 * An installation that only ever self-updates runs the fixed application
 * behind the unfixed nginx and is still exposed, while its version number says
 * otherwise. This check is what tells the operator to pull an image.
 *
 * The real nginx config is asserted against too, so the day someone drops
 * either fix the test fails rather than the detector.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { driftProblemsInNginxConf } from '../src/services/image-drift.js';

/** Pre-0.3.2: recovery proxy present, no document headers. */
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

/** 0.3.2 .. 0.3.11: recovery proxy gone, still no document headers. */
const NO_RECOVERY_PROXY = `
server {
	listen 80 default_server;
	location /api/ {
		proxy_pass http://127.0.0.1:3000;
	}
}
`;

/** 0.3.12 onwards. */
const CURRENT = `
server {
	listen 80 default_server;
	location / {
		add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'" always;
	}
	location /api/ {
		proxy_pass http://127.0.0.1:3000;
	}
}
`;

/** Only the lines about one problem, so each check can be asserted alone. */
function about(conf: string, needle: string): string[] {
	return driftProblemsInNginxConf(conf).filter((p) => p.includes(needle));
}

describe('driftProblemsInNginxConf', () => {
	it('flags an image that still proxies /__recovery/', () => {
		const problems = about(VULNERABLE_CONF, '/__recovery/');
		expect(problems).toHaveLength(1);
		// The operator needs to be told what to actually do about it.
		expect(problems[0]).toContain('docker compose pull');
	});

	it('says nothing about /__recovery/ once the block is gone', () => {
		expect(NO_RECOVERY_PROXY).not.toContain('__recovery');
		expect(about(NO_RECOVERY_PROXY, '__recovery')).toEqual([]);
	});

	it('is not fooled by the word appearing in a comment only', () => {
		const commentOnly = '# never proxy /__recovery/ from normal mode\nserver { listen 80; }\n';
		expect(about(commentOnly, '__recovery')).toEqual([]);
	});

	it('flags an image whose UI can be framed', () => {
		// Every pre-0.3.12 image: the /__recovery/ fix had landed, this one
		// had not, and both live in a file the updater cannot replace.
		const problems = driftProblemsInNginxConf(NO_RECOVERY_PROXY);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('frame');
		expect(problems[0]).toContain('docker compose pull');
	});

	it('says nothing once the headers are there', () => {
		expect(driftProblemsInNginxConf(CURRENT)).toEqual([]);
	});

	it('reports both problems for an image that predates both fixes', () => {
		expect(driftProblemsInNginxConf(VULNERABLE_CONF)).toHaveLength(2);
	});

	it("the repository's own normal-mode config is clean", () => {
		// Guards both fixes: dropping either one fails here.
		const conf = readFileSync(
			fileURLToPath(new URL('../../../docker/nginx/cloudgate.conf', import.meta.url)),
			'utf8'
		);
		expect(driftProblemsInNginxConf(conf)).toEqual([]);
	});
});
