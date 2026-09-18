/**
 * Detects fixes that a self-update cannot deliver.
 *
 * The self-updater replaces `/app/{backend,frontend,recovery-ui}` and nothing
 * else — that is all the release tarball contains. Everything else that makes
 * up a running CloudGate is baked into the container image: the nginx configs
 * at `/etc/nginx-cloudgate/`, the service scripts under `/etc/s6-overlay/`,
 * and `bootstrap.sh` / `apply-update.sh` in `/app/bin/`.
 *
 * So an installation that only ever updates through the UI keeps the image it
 * was first started from. Application bugs get fixed; anything living in those
 * other files does not. That is fine for most changes and emphatically not
 * fine for one of them:
 *
 *   0.3.2 removed the `/__recovery/` proxy from the normal-mode nginx config.
 *   Until then, nginx forwarded that path to the recovery service, which has
 *   no authentication of its own and can read the log holding the initial
 *   admin password or move /data aside. An installation that self-updated past
 *   0.3.2 is running fixed code behind an unfixed proxy, and is still exposed.
 *
 * There is no way for the updater to close that from inside `/app`. What it
 * can do is say so, loudly and specifically, instead of letting the release
 * notes imply a fix that did not arrive. `docker compose pull` is the remedy.
 */

import { existsSync, readFileSync } from 'node:fs';
import { childLogger } from '../logger.js';

const log = childLogger('image-drift');

/** Where the image keeps the nginx config the s6 service copies into place. */
const NORMAL_MODE_NGINX_CONF = '/etc/nginx-cloudgate/cloudgate.conf';

export interface ImageDrift {
	/** True when the running image predates a fix that only an image can carry. */
	stale: boolean;
	/** One line per problem found, safe to show an operator verbatim. */
	problems: string[];
}

/**
 * The file-content half of the check, split out so it can be tested without a
 * container. Returns one problem line per outdated thing found.
 */
export function driftProblemsInNginxConf(conf: string): string[] {
	const problems: string[] = [];
	// The 0.3.2 fix deleted this location block. Its presence means the image
	// predates it, whatever /app/.version now says.
	if (/location\s+\/__recovery\//.test(conf)) {
		problems.push(
			'The container image still forwards /__recovery/ to the recovery service, which has no login of its own. ' +
				'Updating through the UI cannot replace this file. Pull a new container image (docker compose pull) and recreate the container.'
		);
	}
	return problems;
}

let cached: ImageDrift | null = null;

/**
 * Check the image-level files for known-outdated content.
 *
 * Cheap and cached: these files cannot change while the container runs, since
 * replacing them is precisely what requires a new image.
 */
export function checkImageDrift(): ImageDrift {
	if (cached) return cached;

	const problems: string[] = [];

	// Absent outside the container (tests, local dev) — nothing to say then.
	if (existsSync(NORMAL_MODE_NGINX_CONF)) {
		try {
			problems.push(...driftProblemsInNginxConf(readFileSync(NORMAL_MODE_NGINX_CONF, 'utf8')));
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'Could not read the image nginx config');
		}
	}

	cached = { stale: problems.length > 0, problems };

	if (cached.stale) {
		for (const problem of cached.problems) {
			log.error({ remedy: 'docker compose pull' }, problem);
		}
	}

	return cached;
}
