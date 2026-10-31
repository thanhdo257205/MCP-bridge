import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyWorktreeChanges } from '../src/isolation/apply.js';
import { worktreeFileDiff } from '../src/isolation/diff.js';
import { createWorktree } from '../src/isolation/worktree.js';

const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
  });
});

async function repository() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-harden-'));
  const repo = path.join(dir, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(repo, 'secret.txt'), 'do not delete me\nplease\nkeep\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  return {dir, repo, state: path.join(dir, 'state'), cleanup: () => rm(dir, {recursive: true, force: true})};
}

test('apply refuses a rename out of a path the task does not own, and the protected file survives', async () => {
  const {repo, state, cleanup} = await repository();
  try {
    const wt = await createWorktree({workspace: repo, stateDirectory: state, taskId: '11111111-1111-4111-8111-111111111111'});
    // Without rename detection turned off the diff lists only `a2.txt`, and applying it would delete secret.txt from the workspace.
    await git(wt.root, ['mv', 'secret.txt', 'a2.txt']);
    const result = await applyWorktreeChanges({worktree: wt.root, toplevel: wt.toplevel, workspace: repo, owns: ['a2.txt']});
    assert.equal(result.applied, false);
    assert.match(result.applied ? '' : result.reason, /owned paths were changed \(secret\.txt\)/);
    assert.equal(existsSync(path.join(repo, 'secret.txt')), true, 'the protected file is still in the workspace');
    assert.equal(existsSync(path.join(repo, 'a2.txt')), false, 'nothing was applied');
  } finally { await cleanup(); }
});

test('a rename inside the owned paths is applied as a delete plus an add', async () => {
  const {repo, state, cleanup} = await repository();
  try {
    const wt = await createWorktree({workspace: repo, stateDirectory: state, taskId: '22222222-2222-4222-8222-222222222222'});
    await git(wt.root, ['mv', 'a.txt', 'a2.txt']);
    const result = await applyWorktreeChanges({worktree: wt.root, toplevel: wt.toplevel, workspace: repo, owns: ['a.txt', 'a2.txt']});
    assert.equal(result.applied, true);
    assert.equal(existsSync(path.join(repo, 'a.txt')), false);
    assert.equal(await readFile(path.join(repo, 'a2.txt'), 'utf8'), 'one\ntwo\nthree\n');
  } finally { await cleanup(); }
});

test('file names git treats specially are applied and shown literally', async () => {
  const {repo, state, cleanup} = await repository();
  try {
    const names = ['-n.txt', 'with space.txt', 'a[1].txt', "q'uote.txt", 'ünï.txt'];
    const wt = await createWorktree({workspace: repo, stateDirectory: state, taskId: '33333333-3333-4333-8333-333333333333'});
    for (const name of names) await writeFile(path.join(wt.root, name), 'new\n');
    for (const name of names) assert.equal((await worktreeFileDiff(wt.root, name)).changed, true, name);
    const result = await applyWorktreeChanges({worktree: wt.root, toplevel: wt.toplevel, workspace: repo, owns: names});
    assert.equal(result.applied, true);
    for (const name of names) assert.equal(existsSync(path.join(repo, name)), true, name);
  } finally { await cleanup(); }
});

test('a workspace directory with glob characters does not pull in its sibling', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-harden-'));
  try {
    const top = path.join(dir, 'repo');
    await mkdir(top);
    await git(top, ['init', '-q']);
    await mkdir(path.join(top, 'src[1]'));
    await mkdir(path.join(top, 'src1'));
    await writeFile(path.join(top, 'src[1]', 'a.txt'), 'base\n');
    await writeFile(path.join(top, 'src1', 'other.txt'), 'other\n');
    await git(top, ['add', '-A']);
    await git(top, ['commit', '-qm', 'init']);
    const sub = path.join(top, 'src[1]');
    const wt = await createWorktree({workspace: sub, stateDirectory: path.join(dir, 'state'), taskId: '44444444-4444-4444-8444-444444444444'});
    await writeFile(path.join(wt.workspace, 'a.txt'), 'changed\n');
    await writeFile(path.join(wt.root, 'src1', 'other.txt'), 'sibling changed\n');
    const result = await applyWorktreeChanges({worktree: wt.root, toplevel: wt.toplevel, workspace: sub, owns: ['a.txt']});
    assert.deepEqual(result.applied && result.files, ['a.txt']);
    assert.equal(await readFile(path.join(top, 'src1', 'other.txt'), 'utf8'), 'other\n', 'the sibling directory was not touched');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the diff refuses a path that reaches outside the worktree through a link', async t => {
  const {dir, repo, state, cleanup} = await repository();
  try {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'PRIVATE CONTENT OUTSIDE\n');
    const wt = await createWorktree({workspace: repo, stateDirectory: state, taskId: '55555555-5555-4555-8555-555555555555'});
    // A junction on Windows (no privilege needed), a plain symlink elsewhere.
    try { await symlink(outside, path.join(wt.root, 'escape'), 'junction'); }
    catch { t.skip('this platform does not let the test create a link'); return; }
    await assert.rejects(worktreeFileDiff(wt.root, 'escape/private.txt'), /leaves the worktree through a link/);
    assert.equal((await worktreeFileDiff(wt.root, 'a.txt')).changed, false, 'an ordinary file is still read');
  } finally { await cleanup(); }
});
