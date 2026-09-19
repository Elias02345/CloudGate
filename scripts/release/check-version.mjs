#!/usr/bin/env node
/**
 * Verifies every package that ships in a release tarball agrees on one
 * version number.
 *
 * Usage:
 *   node scripts/release/check-version.mjs v1.2.3   # release gate: tag vs. files
 *   node scripts/release/check-version.mjs          # dev check: root package.json vs. files
 *   pnpm release:check                              # same as above, via root script
 *
 * packages/recovery-ui is versioned independently and is intentionally
 * NOT part of this check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export const CHECKED_FILES = [
  'package.json',
  'packages/backend/package.json',
  'packages/frontend/package.json',
  'packages/shared/package.json',
  'packages/backend/.version',
];

export function extractVersion(relPath, content) {
  return relPath.endsWith('.json') ? JSON.parse(content).version : content.trim();
}

/** Pure comparison — no filesystem access, easy to unit test. */
export function checkVersions(expected, entries) {
  const mismatches = [];
  for (const { path: relPath, content } of entries) {
    const found = extractVersion(relPath, content);
    if (found !== expected) mismatches.push({ path: relPath, found });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function readEntries(root) {
  return CHECKED_FILES.map((relPath) => ({
    path: relPath,
    content: readFileSync(path.join(root, relPath), 'utf8'),
  }));
}

function main() {
  const tagArg = process.argv[2];
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const expected = tagArg ? tagArg.replace(/^v/, '') : rootPkg.version;

  const { ok, mismatches } = checkVersions(expected, readEntries(repoRoot));

  if (!ok) {
    console.error(`Version check failed: expected "${expected}"`);
    for (const m of mismatches) {
      console.error(`  - ${m.path}: found "${m.found}"`);
    }
    console.error('\n(packages/recovery-ui is versioned independently and is not checked here.)');
    process.exitCode = 1;
    return;
  }

  console.log(`OK: package.json, backend, frontend, shared and backend/.version all report ${expected}`);
  console.log('(packages/recovery-ui is versioned independently and is not checked here.)');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
