import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAgent } from '../src/agents/codex.js';
import type { AgentStatus } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { readDecisions } from '../src/decisions.js';
import { TaskManager } from '../src/tasks/manager.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-codex.mjs', import.meta.url));
const status: AgentStatus = {id: 'codex', label: 'Codex', available: true, version: 'fake', executable: 'fixture', capabilities: ['code'], warnings: []};
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
  });
});

async function setup(target = 'scope') {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-apply-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  await writeFile(path.join(repo, 'b.txt'), 'other\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const state = path.join(root, 'state');
  const config: Config = {
    allowed_workspaces: [repo], executable: process.execPath, max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'write', target, '50'], source: 'fixture'}, status);
  const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: state, agents: [agent], defaultAgent: 'codex'});
  const run = async (owns = ['a.txt']) => {
    const started = await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation: 'worktree', owns});
    return manager.wait(started.task_id);
  };
  const finish = async () => { await manager.shutdown(); await rm(root, {recursive: true, force: true}); };
  return {root, repo, state, manager, run, finish};
}

test('applying a finished worktree task leaves its changes uncommitted in the workspace and records the decision', async () => {
  const {repo, state, manager, run, finish} = await setup();
  try {
    const done = await run();
    assert.equal(done.status, 'completed');
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'base\n', 'nothing reaches the workspace before the owner decides');

    const applied = await manager.applyTask(done.task_id);
    assert.deepEqual(applied.files, ['a.txt']);
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'edited by codex\n');
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), 'M a.txt', 'the edit is left uncommitted, never committed for the owner');
    assert.equal((await git(repo, ['log', '--oneline'])).trim().split(/\r?\n/).length, 1, 'no commit was made');
    assert.ok(applied.task.applied_at);
    assert.deepEqual(applied.task.applied_files, ['a.txt']);

    const [decision] = await readDecisions(state);
    assert.equal(decision.action, 'apply'); assert.equal(decision.ok, true); assert.equal(decision.task_id, done.task_id);
    await assert.rejects(manager.applyTask(done.task_id), /already applied/);
  } finally { await finish(); }
});

test('apply is refused, and says why, when the workspace has uncommitted edits in the same file', async () => {
  const {repo, state, manager, run, finish} = await setup();
  try {
    const done = await run();
    await writeFile(path.join(repo, 'a.txt'), 'my own edit\n');
    await assert.rejects(manager.applyTask(done.task_id), /uncommitted changes in: a\.txt/);
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'my own edit\n', 'the owner\'s edit is untouched');
    const [decision] = await readDecisions(state);
    assert.equal(decision.ok, false);
    assert.match(decision.detail, /uncommitted changes/);
  } finally { await finish(); }
});

test('apply is refused when the workspace moved on and the patch no longer fits', async () => {
  const {repo, manager, run, finish} = await setup();
  try {
    const done = await run();
    await writeFile(path.join(repo, 'a.txt'), 'committed meanwhile\n');
    await git(repo, ['commit', '-qam', 'move on']);
    await assert.rejects(manager.applyTask(done.task_id), /no longer fit the workspace/);
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'committed meanwhile\n');
    assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '', 'a refused apply writes nothing');
  } finally { await finish(); }
});

test('apply refuses a task that changed files outside its owned paths', async () => {
  const {manager, run, finish} = await setup('a.txt');
  try {
    // The agent always writes a.txt, but the task only owns b.txt.
    const done = await run(['b.txt']);
    assert.deepEqual(done.scope?.out_of_scope, ['a.txt']);
    await assert.rejects(manager.applyTask(done.task_id), /outside its owned paths \(a\.txt\)/);
  } finally { await finish(); }
});

test('only a finished worktree task can be applied or discarded', async () => {
  const {repo, manager, finish} = await setup();
  try {
    await assert.rejects(manager.applyTask('00000000-0000-4000-8000-000000000000'), /Unknown or expired/);
    const plain = await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex'});
    await manager.wait(plain.task_id);
    await assert.rejects(manager.applyTask(plain.task_id), /did not run in a worktree/);
    await assert.rejects(manager.discardTask(plain.task_id), /did not run in a worktree/);
  } finally { await finish(); }
});

test('discarding removes the worktree and its branch, keeps the workspace as it was, and ends further decisions', async () => {
  const {repo, state, manager, run, finish} = await setup();
  try {
    const done = await run();
    const discarded = await manager.discardTask(done.task_id);
    assert.ok(discarded.discarded_at);
    assert.equal(existsSync(done.worktree!), false, 'the directory is gone');
    assert.equal((await git(repo, ['branch', '--list', done.branch!])).trim(), '', 'the branch is gone');
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'base\n', 'the workspace never received the changes');
    assert.equal((await readDecisions(state))[0].action, 'discard');
    await assert.rejects(manager.applyTask(done.task_id), /already discarded/);
    await assert.rejects(manager.discardTask(done.task_id), /already discarded/);
  } finally { await finish(); }
});

test('the decision log is newest first and a damaged line is skipped', async () => {
  const {state, finish} = await setup();
  try {
    await mkdir(state, {recursive: true});
    const line = (task_id: string, ok: boolean) => JSON.stringify({at: new Date().toISOString(), task_id, action: 'apply', ok, detail: 'x'});
    await writeFile(path.join(state, 'decisions.jsonl'), [line('a', true), 'not json', line('b', false)].join('\n') + '\n');
    assert.deepEqual((await readDecisions(state)).map(item => item.task_id), ['b', 'a']);
  } finally { await finish(); }
});

test('apply refuses a symlink, which could point outside the workspace', async t => {
  const {repo, manager, run, finish} = await setup();
  try {
    const done = await run(['a.txt', 'link.txt']);
    try { await symlink(path.join(repo, '..', 'elsewhere'), path.join(done.worktree!, 'link.txt')); }
    catch { t.skip('this platform does not let the test create a symlink'); return; }
    await assert.rejects(manager.applyTask(done.task_id), /symlink or a submodule/);
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'base\n', 'nothing was applied, not even the file that was fine');
  } finally { await finish(); }
});
