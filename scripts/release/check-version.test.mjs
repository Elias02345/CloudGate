import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVersions } from './check-version.mjs';

test('passes when every file reports the expected version', () => {
  const result = checkVersions('1.2.3', [
    { path: 'package.json', content: '{"version":"1.2.3"}' },
    { path: 'packages/backend/.version', content: '1.2.3\n' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test('reports every mismatching file', () => {
  const result = checkVersions('1.2.3', [
    { path: 'package.json', content: '{"version":"1.2.3"}' },
    { path: 'packages/backend/package.json', content: '{"version":"1.2.4"}' },
    { path: 'packages/backend/.version', content: '1.2.3' },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, [{ path: 'packages/backend/package.json', found: '1.2.4' }]);
});
