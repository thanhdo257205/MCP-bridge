import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree, pruneWorktrees, removeWorktree, sweepStaleWorktrees, type Worktree } from '../src/isolation/worktree.js';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-worktree-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);
  const state = path.join(root, 'state');
  return {root, repo, state};
}

test('a removed worktree loses its directory and its branch, and the removal is idempotent', async () => {
  const {repo, state} = await repository();
  const id = randomUUID();
  const worktree = await createWorktree({workspace: repo, stateDirectory: state, taskId: id});
  assert.equal((await removeWorktree(worktree)).removed, true);

  assert.equal(existsSync(worktree.root), false, 'the directory is gone');
  assert.equal((await git(repo, ['branch', '--list', worktree.branch])).trim(), '', 'the branch is gone');
  assert.equal((await git(repo, ['worktree', 'list'])).trim().split(/\r?\n/).length, 1, 'only the original workspace remains registered');

  const again = await removeWorktree(worktree);
  assert.equal(again.removed, true, 'removing an already removed worktree is success, not a failure');
});

test('a worktree directory that is still held is reported instead of swallowed', async () => {
  const {repo, state} = await repository();
  const worktree = await createWorktree({workspace: repo, stateDirectory: state, taskId: randomUUID()});
  // A git call that cannot reach the worktree stands in for the Windows case where the directory exists but a
  // process still holds it open: the removal must say so rather than pretend the tree is clean.
  const blocked: Worktree = {...worktree, toplevel: path.join(state, 'not-a-repository')};
  const result = await removeWorktree(blocked, {retryDelayMs: [0, 0]});
  assert.equal(result.removed, false);
  assert.match(result.reason ?? '', /still held by a running process/);
  assert.match(result.reason ?? '', /last error/);
});

test('the sweep removes only empty leftovers and never touches work kept for review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-sweep-'));
  const state = path.join(root, 'state');
  const worktrees = path.join(state, 'worktrees');
  const tasks = path.join(state, 'tasks');
  await mkdir(worktrees, {recursive: true});
  await mkdir(tasks, {recursive: true});

  const empty = randomUUID();
  const busy = randomUUID();
  const reviewed = randomUUID();
  const running = randomUUID();
  for (const id of [empty, busy, reviewed, running]) await mkdir(path.join(worktrees, id), {recursive: true});
  await mkdir(path.join(worktrees, 'scratch'));
  await writeFile(path.join(worktrees, reviewed, 'important.txt'), 'the diff someone has not merged yet\n');
  await writeFile(path.join(tasks, `${running}.json`), JSON.stringify({task: {status: 'running'}}));
  await writeFile(path.join(tasks, `${empty}.json`), JSON.stringify({status: 'completed'}));

  const report = await sweepStaleWorktrees(state, {
    remove: async (target: string) => {
      if (target.endsWith(busy)) throw Object.assign(new Error('Device or resource busy'), {code: 'EBUSY'});
      await rmdir(target);
      return 'rmdir' as const;
    },
    retryDelayMs: [0]
  });

  assert.equal(report.scanned, 5);
  assert.deepEqual(report.removed.map(item => path.basename(item)), [empty], 'only the empty leftover of a finished task goes');
  const kept = new Map(report.retained.map(item => [path.basename(item.path), item.reason]));
  assert.match(kept.get(reviewed) ?? '', /still holds files for review/);
  assert.match(kept.get(running) ?? '', /task is running/);
  assert.match(kept.get(busy) ?? '', /Device or resource busy/, 'a locked directory is reported, not forced');
  assert.match(kept.get('scratch') ?? '', /not a task worktree directory/);
  assert.equal(await readFile(path.join(worktrees, reviewed, 'important.txt'), 'utf8'), 'the diff someone has not merged yet\n', 'review work survives the sweep');

  const nothing = await sweepStaleWorktrees(path.join(root, 'missing-state'));
  assert.deepEqual(nothing, {scanned: 0, removed: [], retained: [], prunable: []}, 'a first run with no state directory is not an error');
});

test('the sweep drops the git admin record with the directory it removes', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'agy-sweep-repo-'));
  const state = path.join(repo, 'state');
  const worktrees = path.join(state, 'worktrees');
  await mkdir(worktrees, {recursive: true});
  await mkdir(path.join(state, 'tasks'), {recursive: true});
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'base']);

  const id = randomUUID();
  const worktree = await createWorktree({workspace: repo, stateDirectory: state, taskId: id});
  await writeFile(path.join(state, 'tasks', `${id}.json`), JSON.stringify({task: {status: 'completed', worktree: worktree.root, worktree_toplevel: worktree.toplevel}}));
  await rm(worktree.root, {recursive: true, force: true});

  const report = await sweepStaleWorktrees(state, {retryDelayMs: [0]});
  assert.deepEqual(report.removed, [], 'a directory that is already gone is not reported as one the sweep deleted');
  assert.deepEqual(report.retained, [], 'a missing directory is not a leftover held for review');
  assert.deepEqual(report.prunable, [worktree.toplevel], 'the record left inside the repository is named so it can be cleared');

  const pruned = await pruneWorktrees(worktree.toplevel, worktrees);
  assert.equal(pruned.pruned, 1, `git still lists the deleted worktree until it is pruned (${JSON.stringify(pruned)})`);
  assert.equal(pruned.reason, '');
  assert.deepEqual((await pruneWorktrees(worktree.toplevel, worktrees)).pruned, 0, 'a second prune finds nothing left to clear');
});

test('pruning clears the bridge worktrees whose directory is gone and leaves every other record alone', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'agy-prune-scope-'));
  const state = path.join(repo, 'state');
  const worktrees = path.join(state, 'worktrees');
  await mkdir(worktrees, {recursive: true});
  await git(repo, ['init', '-b', 'main']);
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'base']);

  const bridge = await createWorktree({workspace: repo, stateDirectory: state, taskId: randomUUID()});
  // A worktree the user made by hand, on a drive that is unmounted right now.
  const byHand = path.join(await mkdtemp(path.join(tmpdir(), 'agy-prune-hand-')), 'checkout');
  await git(repo, ['worktree', 'add', '-b', 'by-hand', byHand]);
  // A bridge-side worktree someone locked on purpose.
  const lockedPath = path.join(worktrees, randomUUID());
  await git(repo, ['worktree', 'add', '-b', 'locked-one', lockedPath]);
  await git(repo, ['worktree', 'lock', lockedPath]);
  for (const gone of [bridge.root, byHand, lockedPath]) await rm(gone, {recursive: true, force: true});

  const result = await pruneWorktrees(repo, worktrees);
  assert.equal(result.reason, '');
  assert.equal(result.pruned, 1, 'only the unlocked bridge worktree is cleared');
  const listed = (await git(repo, ['worktree', 'list', '--porcelain'])).replace(/\\/g, '/');
  assert.ok(!listed.includes(bridge.root.replace(/\\/g, '/')), 'the bridge worktree record is gone');
  assert.ok(listed.includes(byHand.replace(/\\/g, '/')), 'a worktree made by hand keeps its record');
  assert.ok(listed.includes(lockedPath.replace(/\\/g, '/')), 'a locked record is never touched');
});

test('a repository whose directory went without git is queued for pruning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-sweep-prune-'));
  const state = path.join(root, 'state');
  const id = randomUUID();
  const repo = path.join(root, 'repo');
  const missing = path.join(state, 'worktrees', id);
  await mkdir(missing, {recursive: true});
  await mkdir(path.join(state, 'tasks'), {recursive: true});
  await writeFile(path.join(state, 'tasks', `${id}.json`), JSON.stringify({task: {status: 'failed', worktree: missing, worktree_toplevel: repo}}));

  const report = await sweepStaleWorktrees(state, {remove: async target => { await rmdir(target); return 'rmdir'; }, retryDelayMs: [0]});
  assert.deepEqual(report.removed.map(item => path.basename(item)), [id]);
  assert.deepEqual(report.prunable, [repo], 'the deleted directory leaves its record inside the repository');

  const repeat = await sweepStaleWorktrees(state, {retryDelayMs: [0]});
  assert.deepEqual(repeat.prunable, [repo], 'a task record naming a vanished worktree is found even with no directory left');

  const unknown = await sweepStaleWorktrees(state, {readRecord: async () => ({status: 'failed', repo: null, worktree: missing}), retryDelayMs: [0]});
  assert.deepEqual(unknown.prunable, [], 'a leftover with no repository in its record cannot be queued for anyone');

  const live = await sweepStaleWorktrees(state, {readRecord: async () => ({status: 'running', repo, worktree: missing}), retryDelayMs: [0]});
  assert.deepEqual(live.prunable, [], 'a task that is still running keeps its worktree entry');
});

test('the sweep reads both historical and current task record shapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-sweep-shapes-'));
  const state = path.join(root, 'state');
  await mkdir(path.join(state, 'worktrees'), {recursive: true});
  await mkdir(path.join(state, 'tasks'), {recursive: true});
  const current = randomUUID();
  const legacy = randomUUID();
  for (const id of [current, legacy]) await mkdir(path.join(state, 'worktrees', id), {recursive: true});
  await writeFile(path.join(state, 'tasks', `${current}.json`), JSON.stringify({task: {status: 'queued'}, request: {task: 'x'}}));
  await writeFile(path.join(state, 'tasks', `${legacy}.json`), JSON.stringify({status: 'running'}));

  const report = await sweepStaleWorktrees(state);
  assert.deepEqual(report.removed, [], 'a task that has not finished still owns its worktree directory');
  assert.deepEqual(report.retained.map(item => item.reason).sort(), ['task is queued', 'task is running']);
});
