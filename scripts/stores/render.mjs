#!/usr/bin/env node
// Rewrites version / image tag+digest / release notes across the app-store
// packages under packaging/. Plain line-based text edits on purpose: no YAML
// library is a dependency anywhere in this workspace (checked
// pnpm-lock.yaml), so this avoids adding one just to touch a handful of
// fields in two files.
//
// Usage:
//   node scripts/stores/render.mjs <X.Y.Z> <sha256:digest>
//
// What it touches:
//   - packaging/umbrel/cloudgate/umbrel-app.yml   (version, releaseNotes)
//   - packaging/umbrel/cloudgate/docker-compose.yml   (image tag+digest)
//   - packaging/zimaos/CloudGate/docker-compose.yml
//     (x-casaos.version, update_at, release_notes, image tag+digest)
//
// What it deliberately does NOT touch:
//   - packaging/truenas/**: TrueNAS's own Renovate bot bumps ix_values.yaml
//     image tags after a PR merges into truenas/apps (see
//     CONTRIBUTIONS.md's renovate-config.js mention); app.yaml's `version`
//     is *our* package version there (bumped by hand per their contribution
//     guide, not tied to CloudGate's version), so it isn't this script's
//     job either. See packaging/README.md.
//   - packaging/unraid/**: `Repository` is pinned to `:latest` by design
//     (Unraid convention), so there is no tag/digest field to rewrite.
//
// Deterministic: for the same (version, digest, CHANGELOG.md, today's date)
// it always writes byte-identical output, so running it twice back to back
// is a no-op diff.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_RE = /ghcr\.io\/elias02345\/cloudgate:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}/;

export function parseArgs(argv) {
  const [version, digest] = argv;
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version ?? ""}" — expected X.Y.Z, e.g. 0.3.14.`);
  }
  if (!digest || !DIGEST_RE.test(digest)) {
    throw new Error(`Invalid digest "${digest ?? ""}" — expected sha256:<64 lowercase hex chars>.`);
  }
  return { version, digest };
}

// --- CHANGELOG.md extraction --------------------------------------------

/**
 * Pull a short summary out of CHANGELOG.md's `## [X.Y.Z]` section: up to 5
 * top-level bullet lines (first line of each, continuation lines dropped),
 * plus whether the section has a "Breaking Changes" subsection.
 */
export function extractReleaseNotes(changelogText, version) {
  const lines = changelogText.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (startIdx === -1) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section.`);
  }
  let endIdx = lines.findIndex((l, i) => i > startIdx && /^## \[/.test(l));
  if (endIdx === -1) endIdx = lines.length;
  const section = lines.slice(startIdx + 1, endIdx);

  const breaking = section.some((l) => /^### .*breaking/i.test(l));
  const bullets = section
    .filter((l) => /^- /.test(l))
    .slice(0, 5)
    .map((l) => l.replace(/^- /, "").trim());

  if (bullets.length === 0) {
    throw new Error(`CHANGELOG.md's "## [${version}]" section has no top-level bullet lines.`);
  }

  return { breaking, bullets };
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((l) => (l.length ? prefix + l : ""))
    .join("\n");
}

/** Folded-scalar (`>-`) body: matches the two-blank-lines-per-paragraph,
 * one-blank-line-per-list-item convention documented by the Umbrel
 * umbrel-package-app skill for `description`/`releaseNotes`. */
function foldedBulletBody(bullets, breaking) {
  const list = bullets.map((b) => `- ${b}`).join("\n\n");
  if (!breaking) return list;
  return `⚠ Breaking changes: see CHANGELOG.md.\n\n\n${list}`;
}

/** Literal-scalar (`|`) body for ZimaOS, which has no folding rules to
 * respect — plain lines, breaking marker first if present. */
function literalBulletBody(bullets, breaking) {
  const items = breaking ? ["⚠ Breaking changes: see CHANGELOG.md.", ...bullets] : bullets;
  return items.map((b) => `- ${b}`).join("\n");
}

/** Replace the span of lines from `startPredicate` (inclusive) up to the
 * next line matching `endPredicate` (exclusive) with `replacement`. Used
 * instead of a YAML library to regenerate one multi-line block in place. */
function replaceSpan(text, startPredicate, endPredicate, replacement) {
  const lines = text.split("\n");
  const startIdx = lines.findIndex(startPredicate);
  if (startIdx === -1) {
    throw new Error(`replaceSpan: no line matched the start predicate.`);
  }
  let endIdx = lines.findIndex((l, i) => i > startIdx && endPredicate(l));
  if (endIdx === -1) endIdx = lines.length;
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  return [...before, ...replacement.split("\n"), ...after].join("\n");
}

function replaceImage(text, version, digest) {
  if (!IMAGE_RE.test(text)) {
    throw new Error("Could not find a ghcr.io/elias02345/cloudgate:vX.Y.Z@sha256:... image reference to replace.");
  }
  return text.replace(IMAGE_RE, `ghcr.io/elias02345/cloudgate:v${version}@${digest}`);
}

// --- Umbrel ---------------------------------------------------------------

export function renderUmbrelManifest(text, version, bullets, breaking) {
  text = text.replace(/^version: ".*"$/m, `version: "${version}"`);

  const body = indent(foldedBulletBody(bullets, breaking), "  ");
  text = replaceSpan(
    text,
    (l) => l.startsWith("releaseNotes:"),
    (l) => /^\S/.test(l),
    `releaseNotes: >-\n${body}`,
  );
  return text;
}

export function renderUmbrelCompose(text, version, digest) {
  return replaceImage(text, version, digest);
}

// --- ZimaOS -----------------------------------------------------------------

export function renderZimaCompose(text, version, digest, bullets, breaking, today) {
  text = replaceImage(text, version, digest);
  text = text.replace(/^(\s*version:\s*)"[0-9.]+"$/m, `$1"${version}"`);
  text = text.replace(/^(\s*update_at:\s*)"[0-9-]+"$/m, `$1"${today}"`);

  const body = indent(literalBulletBody(bullets, breaking), "      ");
  text = replaceSpan(
    text,
    (l) => /^\s*release_notes:\s*$/.test(l),
    (l) => /^ {2}\S/.test(l),
    `  release_notes:\n    en_US: |\n${body}`,
  );
  return text;
}

// --- main -------------------------------------------------------------------

function readFile(p) {
  return readFileSync(p, "utf8");
}

export function render({ version, digest, changelogText, today = new Date().toISOString().slice(0, 10) }) {
  const { breaking, bullets } = extractReleaseNotes(changelogText, version);

  const umbrelManifestPath = path.join(ROOT, "packaging/umbrel/cloudgate/umbrel-app.yml");
  const umbrelComposePath = path.join(ROOT, "packaging/umbrel/cloudgate/docker-compose.yml");
  const zimaComposePath = path.join(ROOT, "packaging/zimaos/CloudGate/docker-compose.yml");

  const files = {
    [umbrelManifestPath]: renderUmbrelManifest(readFile(umbrelManifestPath), version, bullets, breaking),
    [umbrelComposePath]: renderUmbrelCompose(readFile(umbrelComposePath), version, digest),
    [zimaComposePath]: renderZimaCompose(readFile(zimaComposePath), version, digest, bullets, breaking, today),
  };

  for (const [filePath, content] of Object.entries(files)) {
    writeFileSync(filePath, content);
  }

  return files;
}

async function main() {
  const { version, digest } = parseArgs(process.argv.slice(2));
  const changelogText = readFile(path.join(ROOT, "CHANGELOG.md"));
  render({ version, digest, changelogText });
  console.log(`Rendered packaging/umbrel and packaging/zimaos for v${version} @ ${digest}`);
}

// Only run when executed directly (`node render.mjs ...`), not when imported
// by the test file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
