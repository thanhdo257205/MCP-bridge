import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nextPatch, releasePlan, validateVersionChange, versionPublished, prepareRelease, finalizeRelease } from '../scripts/auto-release.js';

const source = 'a'.repeat(40), other = 'b'.repeat(40);
test('auto release: stale CI runs skip; retries resume only the direct version commit', () => {
  assert.equal(releasePlan(source, source, other, 'feature'), 'bump');
  assert.equal(releasePlan(source, other, source, `chore(release): 0.1.2 [skip ci]\n\nRelease-Source: ${source}`), 'resume');
  assert.equal(releasePlan(source, other, source, 'another change'), 'stale');
  assert.equal(releasePlan(source, other, other, `chore(release): 0.1.2 [skip ci]\n\nRelease-Source: ${source}`), 'stale');
  assert.throws(() => releasePlan('main', other, source, ''), /full Git commit/);
});

test('auto release: increments only stable patches and refuses changes beyond version', () => {
  assert.equal(nextPatch('0.1.9'), '0.1.10');
  for (const value of ['0.1.0-rc.1', '01.1.0', '', '1.2']) assert.throws(() => nextPatch(value), /stable/);
  validateVersionChange({version: '0.1.1', license: 'MIT'}, {version: '0.1.2', license: 'MIT'});
  assert.throws(() => validateVersionChange({version: '0.1.1', license: 'MIT'}, {version: '0.1.2', license: 'UNLICENSED'}), /only change/);
});

test('auto release: registry check skips an existing version and fails closed on network/server errors', async () => {
  const request = (response: Response) => (async () => response) as typeof fetch;
  assert.equal(await versionPublished('0.1.2', request(new Response('', {status: 404}))), false);
  assert.equal(await versionPublished('0.1.2', request(Response.json({name: 'agy-mcp-bridge', version: '0.1.2'}))), true);
  await assert.rejects(versionPublished('0.1.2', request(new Response('', {status: 503}))), /refusing to assume/);
  await assert.rejects(versionPublished('0.1.2', request(Response.json({version: '0.1.1'}))), /unexpected package/);
  await assert.rejects(versionPublished('0.1.2', (async () => { throw new Error('offline'); }) as typeof fetch), /offline/);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-release-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const remote = path.join(root, 'remote.git'), cwd = path.join(root, 'work');
  await mkdir(cwd); git(root, 'init', '--bare', remote); git(cwd, 'init', '-b', 'main');
  const manifest = {name: 'agy-mcp-bridge', version: '0.1.1', license: 'MIT', publishConfig: {access: 'public'}};
  const lock = {name: manifest.name, version: manifest.version, packages: {'': {name: manifest.name, version: manifest.version}}};
  const manifests = async (version: string) => {
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({...manifest, version}));
    await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({...lock, version, packages: {'': {...lock.packages[''], version}}}));
  };
  await manifests('0.1.1'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  await writeFile(path.join(cwd, 'code.txt'), 'tested code'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'feature');
  git(cwd, 'remote', 'add', 'origin', remote); git(cwd, 'push', '-u', 'origin', 'main');
  return {cwd, remote, manifests, sha: git(cwd, 'rev-parse', 'HEAD')};
}

test('auto release: commits and pushes a version once, then resumes the same tag on retry', async t => {
  const f = await fixture(t);
  assert.equal(prepareRelease(f.cwd, f.sha), 'bump');
  await f.manifests('0.1.2');
  assert.equal(finalizeRelease(f.cwd, f.sha), '0.1.2');
  const released = git(f.cwd, 'rev-parse', 'HEAD');
  assert.equal(git(f.remote, 'rev-parse', 'main'), released);
  assert.equal(git(f.remote, 'rev-parse', 'v0.1.2^{commit}'), released);
  assert.equal(prepareRelease(f.cwd, f.sha), 'resume');
  assert.equal(finalizeRelease(f.cwd, f.sha), '0.1.2');
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), released);
});

test('auto release: a newer push skips old CI and rejects a racing atomic push without creating a remote tag', async t => {
  const f = await fixture(t);
  assert.equal(prepareRelease(f.cwd, f.sha), 'bump');
  const clone = path.join(path.dirname(f.cwd), 'newer');
  git(path.dirname(f.cwd), 'clone', '--branch', 'main', f.remote, clone);
  await writeFile(path.join(clone, 'new.txt'), 'newer code'); git(clone, 'add', '.'); git(clone, 'commit', '-m', 'new feature'); git(clone, 'push');
  await f.manifests('0.1.2');
  assert.throws(() => finalizeRelease(f.cwd, f.sha));
  assert.throws(() => git(f.remote, 'rev-parse', '--verify', 'refs/tags/v0.1.2'));
  assert.equal(prepareRelease(f.cwd, f.sha), 'stale');
});

test('auto release: modified application code after CI cannot be published', async t => {
  const f = await fixture(t);
  assert.equal(prepareRelease(f.cwd, f.sha), 'bump');
  await f.manifests('0.1.2');
  await writeFile(path.join(f.cwd, 'code.txt'), 'untested change');
  assert.throws(() => finalizeRelease(f.cwd, f.sha), /Untested code changes/);
  assert.equal(git(f.remote, 'rev-parse', 'main'), f.sha);
});
