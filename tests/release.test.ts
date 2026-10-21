import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/release-check.js';

const manifest = {name: 'agy-mcp-bridge', version: '1.2.3', license: 'MIT', publishConfig: {access: 'public'}};
const lock = {name: manifest.name, version: manifest.version, packages: {'': {name: manifest.name, version: manifest.version}}};

test('release: stable tag must match the package and both lockfile versions', () => {
  assert.equal(validateRelease('refs/tags/v1.2.3', manifest, lock), '1.2.3');
  assert.throws(() => validateRelease('refs/tags/v1.2.4', manifest, lock), /must match/);
  assert.throws(() => validateRelease('refs/tags/v1.2.3', manifest, {...lock, version: '1.2.2'}), /must match/);
  assert.throws(() => validateRelease('refs/tags/v1.2.3', manifest, {...lock, packages: {'': {...lock.packages[''], version: '1.2.2'}}}), /must match/);
  assert.throws(() => validateRelease('refs/tags/v1.2.3', manifest, {...lock, name: 'another-package'}), /must match/);
});

test('release: refuses branch builds, malformed tags and prereleases on latest', () => {
  for (const ref of [undefined, '', 'refs/heads/main', 'v1.2.3', 'refs/tags/v01.2.3', 'refs/tags/v1.2', 'refs/tags/v1.2.3-rc.1', 'refs/tags/v1.2.3+build']) {
    assert.throws(() => validateRelease(ref, manifest, lock), /stable tag/);
  }
});

test('release: fails closed for a private, renamed, unlicensed or non-public package', () => {
  for (const change of [{private: true}, {name: 'another-package'}, {license: 'UNLICENSED'}, {publishConfig: {access: 'restricted'}}]) {
    assert.throws(() => validateRelease('refs/tags/v1.2.3', {...manifest, ...change}, lock), /public MIT package/);
  }
});
