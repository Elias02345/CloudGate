/**
 * Translation keys are resolved at runtime from JSON that TypeScript never
 * sees, so a key that exists nowhere fails silently: i18next renders the key
 * itself. `common.close` shipped that way as an aria-label, which meant a
 * screen reader read out the string "common.close".
 *
 * These two checks are the cheapest place to catch it — no browser, no render,
 * just the sources and the two JSON files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localeFile = (lng: string) =>
	join(pkgRoot, 'public', 'locales', lng, 'translation.json');

type Tree = { [key: string]: string | Tree };

function load(lng: string): Tree {
	return JSON.parse(readFileSync(localeFile(lng), 'utf8')) as Tree;
}

/** Flattens `{a: {b: "x"}}` to `["a.b"]` — the shape i18next is called with. */
function flatten(tree: Tree, prefix = ''): string[] {
	return Object.entries(tree).flatMap(([key, value]) =>
		typeof value === 'object' && value !== null
			? flatten(value, `${prefix}${key}.`)
			: [`${prefix}${key}`]
	);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return /\.tsx?$/.test(entry.name) ? [full] : [];
	});
}

/**
 * Literal `t('a.b')` calls only. Keys built from a template literal
 * (`t(`onboarding.${name}`)`) cannot be resolved statically and are skipped —
 * the dotted-and-lowercase shape below is what keeps unrelated one-argument
 * `t(...)` calls out of the result.
 */
function literalKeys(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of sourceFiles(join(pkgRoot, 'src'))) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(/\bt\(\s*['"]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)['"]/g)) {
			found.set(match[1], [...(found.get(match[1]) ?? []), file.slice(pkgRoot.length + 1)]);
		}
	}
	return found;
}

describe('i18n', () => {
	it('every key used in the sources exists in en', () => {
		const known = new Set(flatten(load('en')));
		const missing = [...literalKeys()]
			.filter(([key]) => !known.has(key))
			.map(([key, files]) => `${key} (used in ${[...new Set(files)].join(', ')})`);
		expect(missing).toEqual([]);
	});

	it('en and de carry the same keys', () => {
		const en = new Set(flatten(load('en')));
		const de = new Set(flatten(load('de')));
		expect([...en].filter((key) => !de.has(key))).toEqual([]);
		expect([...de].filter((key) => !en.has(key))).toEqual([]);
	});

	it('no translation is blank', () => {
		for (const lng of ['en', 'de']) {
			const tree = load(lng);
			const blank = flatten(tree).filter((key) => {
				const value = key.split('.').reduce<string | Tree | undefined>(
					(node, part) => (typeof node === 'object' && node !== null ? node[part] : undefined),
					tree
				);
				return typeof value === 'string' && value.trim() === '';
			});
			expect(blank, `blank ${lng} translations`).toEqual([]);
		}
	});
});
