import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAgent } from '../src/agents/codex.js';
import type { AgentStatus } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { startHttpBridge } from '../src/http.js';
import { isRelativeFilePath } from '../src/isolation/diff.js';
import { TaskManager } from '../src/tasks/manager.js';
import { missionsFor } from './helpers.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-codex.mjs', import.meta.url));
const status: AgentStatus = {id: 'codex', label: 'Codex', available: true, version: 'fake', executable: 'fixture', capabilities: ['code'], warnings: []};
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
  });
});

async function setup(target = 'scope') {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-diff-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  await writeFile(path.join(repo, 'b.txt'), 'other\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const config: Config = {
    allowed_workspaces: [repo], executable: process.execPath, max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'write', target, '50'], source: 'fixture'}, status);
  const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'codex'});
  const run = async (owns = ['a.txt']) => {
    const started = await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation: 'worktree', owns});
    return manager.wait(started.task_id);
  };
  const finish = async () => { await manager.shutdown(); await rm(root, {recursive: true, force: true}); };
  return {root, repo, manager, run, finish};
}

test('a modified file shows its removed and added lines against the base commit', async () => {
  const {manager, run, finish} = await setup();
  try {
    const done = await run();
    const diff = await manager.fileDiff(done.task_id, 'a.txt');
    assert.equal(diff.changed, true);
    assert.equal(diff.binary, false);
    assert.match(diff.diff, /^-base$/m);
    assert.match(diff.diff, /^\+edited by codex$/m);
  } finally { await finish(); }
});

test('a file the agent created is shown as added lines', async () => {
  const {manager, run, finish} = await setup('new.txt');
  try {
    const done = await run(['new.txt']);
    const diff = await manager.fileDiff(done.task_id, 'new.txt');
    assert.equal(diff.changed, true);
    assert.match(diff.diff, /^\+edited by codex$/m);
    assert.match(diff.diff, /new file mode/);
  } finally { await finish(); }
});

test('a file with no change, or one that does not exist, is reported as unchanged instead of failing', async () => {
  const {manager, run, finish} = await setup();
  try {
    const done = await run();
    assert.equal((await manager.fileDiff(done.task_id, 'b.txt')).changed, false);
    assert.equal((await manager.fileDiff(done.task_id, 'nope/missing.txt')).changed, false);
  } finally { await finish(); }
});

test('only a relative path inside the worktree is accepted', async () => {
  const {manager, run, finish} = await setup();
  try {
    const done = await run();
    for (const bad of ['../a.txt', '/etc/passwd', 'C:/Windows/win.ini', '', 'a//b', 'sub/../a.txt', 'a\0b']) {
      assert.equal(isRelativeFilePath(bad), false, JSON.stringify(bad));
      await assert.rejects(manager.fileDiff(done.task_id, bad), /relative path inside the worktree/, JSON.stringify(bad));
    }
    assert.equal(isRelativeFilePath('src/deep/file.ts'), true);
  } finally { await finish(); }
});

test('the diff is only for a worktree task that still has its worktree', async () => {
  const {repo, manager, run, finish} = await setup();
  try {
    await assert.rejects(manager.fileDiff('00000000-0000-4000-8000-000000000000', 'a.txt'), /Unknown or expired/);
    const plain = await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex'});
    await manager.wait(plain.task_id);
    await assert.rejects(manager.fileDiff(plain.task_id, 'a.txt'), /did not run in a worktree/);
    const done = await run();
    await manager.discardTask(done.task_id);
    await assert.rejects(manager.fileDiff(done.task_id, 'a.txt'), /already discarded/);
  } finally { await finish(); }
});

test('reading a diff changes nothing: the worktree index and the workspace stay as they were', async () => {
  const {repo, manager, run, finish} = await setup();
  try {
    const done = await run();
    const before = await git(done.worktree!, ['status', '--porcelain=v1']);
    await manager.fileDiff(done.task_id, 'a.txt');
    assert.equal(await git(done.worktree!, ['status', '--porcelain=v1']), before, 'nothing was staged');
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '');
  } finally { await finish(); }
});

test('web UI routes: diff needs a valid path, apply and discard need confirm, and a confirmed apply reaches the workspace', async () => {
  const {repo, manager, run, finish} = await setup();
  const bridge = await startHttpBridge({manager, missions: missionsFor(manager, repo), environment: {cli_version: 'mock', allowed_workspaces: [repo]}, port: 0});
  const call = (p: string, init: RequestInit = {}) => fetch(`${bridge.baseUrl}/ui/api/${p}`, {...init, headers: init.body ? {'Content-Type': 'application/json'} : {}});
  try {
    const done = await run();
    const id = done.task_id;
    const ok = await call(`tasks/${id}/diff?path=a.txt`);
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as {diff: string}).diff, /^\+edited by codex$/m);
    assert.equal((await call(`tasks/${id}/diff`)).status, 400, 'a missing path');
    assert.equal((await call(`tasks/${id}/diff?path=${encodeURIComponent('../a.txt')}`)).status, 400, 'a path that leaves the worktree');
    assert.equal((await call('tasks/00000000-0000-4000-8000-000000000000/diff?path=a.txt')).status, 404);

    for (const action of ['apply', 'discard']) {
      const refused = await call(`tasks/${id}/${action}`, {method: 'POST', body: JSON.stringify({})});
      assert.equal(refused.status, 400, `${action} without confirm`);
      assert.match(((await refused.json()) as {error: string}).error, /confirm must be true/);
    }
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '', 'an unconfirmed apply wrote nothing');

    const applied = await call(`tasks/${id}/apply`, {method: 'POST', body: JSON.stringify({confirm: true})});
    assert.equal(applied.status, 200);
    assert.deepEqual(((await applied.json()) as {files: string[]}).files, ['a.txt']);
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), 'M a.txt');
    const log = (await (await call('decisions')).json()) as {decisions: {action: string; ok: boolean}[]};
    assert.deepEqual(log.decisions.map(item => [item.action, item.ok]), [['apply', true]]);
  } finally { await bridge.close(); await finish(); }
});
