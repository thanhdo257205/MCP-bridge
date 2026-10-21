import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceChanges } from '../src/changes.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const skip = hasGit ? false : 'git is not installed';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const fwd = (file: string) => file.replace(/\\/g, '/');
async function repo() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-changes-test-')));
  git(dir, 'init', '-q');
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(dir, 'gone.txt'), 'bye\n');
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'sub', 'b.txt'), 'b\n');
  await writeFile(path.join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('changes: a clean repository reports nothing', {skip}, async () => {
  const dir = await repo();
  const report = await workspaceChanges(dir);
  assert.equal(report.available, true);
  assert.deepEqual([report.changes, report.untracked, report.truncated], [[], [], false]);
  assert.match(String(report.head), /^[0-9a-f]{40}$/);
});
test('changes: modified, deleted and untracked files with line counts; ignored files stay out', {skip}, async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  await rm(path.join(dir, 'gone.txt'));
  await writeFile(path.join(dir, 'new file.txt'), 'hello');
  await writeFile(path.join(dir, 'ignored.log'), 'x');
  const report = await workspaceChanges(dir);
  const byPath = Object.fromEntries(report.changes.map(change => [change.path, change]));
  assert.deepEqual(byPath['a.txt'], {path: 'a.txt', status: 'modified', added: 2, deleted: 1});
  assert.deepEqual(byPath['gone.txt'], {path: 'gone.txt', status: 'deleted', added: 0, deleted: 1});
  assert.deepEqual(report.untracked, [{path: 'new file.txt', bytes: 5}]);
  assert.equal(report.changes.length, 2);
});
test('changes: a workspace that is a subdirectory only reports its own files', {skip}, async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'sub', 'b.txt'), 'b changed\n');
  await writeFile(path.join(dir, 'a.txt'), 'outside\n');
  const report = await workspaceChanges(path.join(dir, 'sub'));
  assert.deepEqual(report.changes.map(change => change.path), ['sub/b.txt']);
});
test('changes: a repository without commits lists everything as untracked; a non-repository is reported', {skip}, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-changes-empty-')));
  git(dir, 'init', '-q');
  await writeFile(path.join(dir, 'x.txt'), 'x');
  const fresh = await workspaceChanges(dir);
  assert.equal(fresh.available, true);
  assert.equal(fresh.head, null);
  assert.deepEqual(fresh.untracked.map(file => file.path), ['x.txt']);
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-changes-plain-')));
  const none = await workspaceChanges(plain);
  assert.equal(none.available, false);
  assert.match(String(none.reason), /Not a usable git repository/);
});
test('changes: line-ending settings of the repository are honored, so CRLF checkouts are not all "modified"', {skip}, async () => {
  const dir = await repo();
  git(dir, 'config', 'core.autocrlf', 'true');
  await writeFile(path.join(dir, 'a.txt'), 'one\r\ntwo\r\nthree\r\n');
  assert.equal(git(dir, 'diff', '--stat').trim(), '', 'the real git diff sees no content change');
  assert.deepEqual((await workspaceChanges(dir)).changes, []);
});
test('changes: commands configured inside the repository are never executed (fsmonitor, filter, textconv, external diff)', {skip}, async () => {
  const dir = await repo();
  const marker = path.join(dir, '..', `marker-${path.basename(dir)}.txt`);
  const script = path.join(dir, '..', `mark-${path.basename(dir)}.js`);
  await writeFile(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');`);
  const command = (tag: string) => `node "${fwd(script)}" ${tag}`;
  git(dir, 'config', 'core.fsmonitor', command('fsmonitor'));
  git(dir, 'config', 'filter.x.clean', command('filter-clean'));
  git(dir, 'config', 'filter.x.smudge', command('filter-smudge'));
  git(dir, 'config', 'diff.x.textconv', command('textconv'));
  git(dir, 'config', 'diff.external', command('external-diff'));
  await writeFile(path.join(dir, '.gitattributes'), '* filter=x diff=x\n');
  const old = new Date('2020-01-01');
  await writeFile(path.join(dir, 'a.txt'), 'one\nchanged\nthree\n');
  const { utimes } = await import('node:fs/promises');
  await utimes(path.join(dir, 'a.txt'), old, old);

  // Control: the plain commands do run them, so this test can fail if the protection is removed.
  spawnSync('git', ['status', '--porcelain'], {cwd: dir});
  spawnSync('git', ['diff', '--stat'], {cwd: dir});
  assert.ok(existsSync(marker), 'control: plain git ran a configured command in the poisoned repository');
  await rm(marker, {force: true});

  const report = await workspaceChanges(dir);
  assert.equal(report.available, true, report.reason);
  assert.ok(report.changes.some(change => change.path === 'a.txt'), 'the change is still reported');
  assert.equal(existsSync(marker), false, `a command from the repository was executed: ${existsSync(marker) ? await readFile(marker, 'utf8') : ''}`);
});
