#!/usr/bin/env node
/**
 * Emits a `.version` file alongside the build output.
 * Reads from the package.json — single source of truth for the release version.
 * Called from `pnpm build` after tsc compiles.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version ?? '0.0.0';

const outPath = resolve(here, '..', '.version');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, version, 'utf8');
console.log(`[write-version] wrote ${version} → ${outPath}`);
