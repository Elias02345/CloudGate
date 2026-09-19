import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  extractReleaseNotes,
  renderUmbrelManifest,
  renderUmbrelCompose,
  renderZimaCompose,
} from "./render.mjs";

// --- input validation -------------------------------------------------

test("parseArgs accepts a valid version and digest", () => {
  const { version, digest } = parseArgs(["0.3.14", "sha256:" + "a".repeat(64)]);
  assert.equal(version, "0.3.14");
  assert.equal(digest, "sha256:" + "a".repeat(64));
});

test("parseArgs rejects a missing or malformed version", () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["v0.3.14", "sha256:" + "a".repeat(64)]));
  assert.throws(() => parseArgs(["0.3", "sha256:" + "a".repeat(64)]));
});

test("parseArgs rejects a missing or malformed digest", () => {
  assert.throws(() => parseArgs(["0.3.14"]));
  assert.throws(() => parseArgs(["0.3.14", "sha256:tooshort"]));
  assert.throws(() => parseArgs(["0.3.14", "a".repeat(64)])); // missing prefix
});

// --- CHANGELOG extraction ----------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

_Nothing yet._

---

## [0.4.0] — 2026-10-01

### Breaking Changes

- Renamed the config key \`foo\` to \`bar\`.

### Fixed

- Fixed a crash on startup.
- Fixed a memory leak.
- A third fix.
- A fourth fix.
- A fifth fix that should be dropped since only 5 fit.

## [0.3.13] — 2026-09-19

### Fixed

- The sidebar could not be used with a keyboard.
- **A crash left no trace.** When an error escaped, the process
  exited before the log was written. Now it is logged first.
`;

test("extractReleaseNotes finds the matching version section", () => {
  const { breaking, bullets, date } = extractReleaseNotes(SAMPLE_CHANGELOG, "0.3.13");
  assert.equal(breaking, false);
  assert.equal(date, "2026-09-19");
  // Wrapped bullets are joined, then reduced to the bold lead-in.
  assert.deepEqual(bullets, ["The sidebar could not be used with a keyboard.", "A crash left no trace."]);
});

test("extractReleaseNotes detects a Breaking Changes subsection and caps at 5 bullets", () => {
  const { breaking, bullets } = extractReleaseNotes(SAMPLE_CHANGELOG, "0.4.0");
  assert.equal(breaking, true);
  assert.equal(bullets.length, 5);
  assert.equal(bullets[0], "Renamed the config key `foo` to `bar`.");
});

test("extractReleaseNotes throws for a version with no CHANGELOG section", () => {
  assert.throws(() => extractReleaseNotes(SAMPLE_CHANGELOG, "9.9.9"));
});

// --- determinism / idempotency ------------------------------------------

const UMBREL_MANIFEST_FIXTURE = `manifestVersion: 1
id: cloudgate
category: networking
name: CloudGate
version: "0.3.13"
tagline: Self-hosted web UI for Cloudflare Tunnels
description: >-
  Some description.
releaseNotes: ""
developer: Elias02345
website: https://github.com/Elias02345/CloudGate
dependencies: []
repo: https://github.com/Elias02345/CloudGate
support: https://github.com/Elias02345/CloudGate/issues
port: 7844
gallery: []
path: ""
defaultUsername: ""
defaultPassword: ""
submitter: Elias02345
submission: "https://github.com/getumbrel/umbrel-apps/pull/TBD"
`;

const UMBREL_COMPOSE_FIXTURE = `version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: cloudgate_web_1
      APP_PORT: 8080

  web:
    image: ghcr.io/elias02345/cloudgate:v0.3.13@sha256:${"a".repeat(64)}
    restart: on-failure
`;

const ZIMA_COMPOSE_FIXTURE = `name: cloudgate
services:
  cloudgate:
    image: ghcr.io/elias02345/cloudgate:v0.3.13@sha256:${"a".repeat(64)}
x-casaos:
  id: io.github.elias02345.cloudgate
  title:
    en_US: CloudGate
  version: "0.3.13"
  update_at: "2026-09-19"
  release_notes:
    en_US: |
      Old notes here.
  website: https://github.com/Elias02345/CloudGate
`;

function twice(fn, ...args) {
  const out1 = fn(...args);
  // Feed the first run's output back in — this is what actually happens
  // when the CLI is invoked twice against the file on disk.
  const rebuiltArgs = [out1, ...args.slice(1)];
  const out2 = fn(...rebuiltArgs);
  return [out1, out2];
}

test("renderUmbrelManifest is idempotent", () => {
  const [out1, out2] = twice(
    renderUmbrelManifest,
    UMBREL_MANIFEST_FIXTURE,
    "0.4.0",
    ["Renamed the config key `foo` to `bar`."],
    true,
  );
  assert.equal(out1, out2);
  assert.match(out1, /version: "0\.4\.0"/);
  assert.match(out1, /releaseNotes: >-/);
  assert.match(out1, /⚠ Breaking changes:/);
});

test("renderUmbrelCompose is idempotent", () => {
  const digest = "sha256:" + "b".repeat(64);
  const [out1, out2] = twice(renderUmbrelCompose, UMBREL_COMPOSE_FIXTURE, "0.4.0", digest);
  assert.equal(out1, out2);
  assert.match(out1, new RegExp(`image: ghcr\\.io/elias02345/cloudgate:v0\\.4\\.0@${digest}`));
});

test("renderZimaCompose is idempotent", () => {
  const digest = "sha256:" + "c".repeat(64);
  const [out1, out2] = twice(
    renderZimaCompose,
    ZIMA_COMPOSE_FIXTURE,
    "0.4.0",
    digest,
    ["Fixed a crash on startup."],
    false,
    "2026-10-01",
  );
  assert.equal(out1, out2);
  assert.match(out1, /version: "0\.4\.0"/);
  assert.match(out1, /update_at: "2026-10-01"/);
  assert.match(out1, /Fixed a crash on startup\./);
});
