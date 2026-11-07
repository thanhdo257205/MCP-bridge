import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAgent } from '../src/agents/codex.js';
import type { AgentStatus } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import type { WorktreeSetup } from '../src/isolation/setup.js';
import { TaskManager } from '../src/tasks/manager.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-codex.mjs', import.meta.url));
const status: AgentStatus = {id: 'codex', label: 'Codex', available: true, version: 'fake', executable: 'fixture', capabilities: ['code'], warnings: []};
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
  });
});
const node = (script: string) => [process.execPath, '-e', script];

async function setup(commands: string[][], timeout_seconds = 30) {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-setup-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  // What setup produces is ignored by the repository, as node_modules is, so it is not reported as an out-of-scope change.
  await writeFile(path.join(repo, '.gitignore'), 'prepared.txt\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const worktree_setup: WorktreeSetup[] = [{workspace: repo, commands, timeout_seconds}];
  const config: Config = {
    allowed_workspaces: [repo], executable: process.execPath, max_timeout_seconds: 60, default_timeout_seconds: 30, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv',
    worktree_setup
  };
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'write', 'scope', '0'], source: 'fixture'}, status);
  const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'codex'});
  const run = async (isolation: 'worktree' | 'none' = 'worktree') => manager.wait((await manager.delegate({
    task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation, ...(isolation === 'worktree' ? {owns: ['a.txt']} : {})
  })).task_id);
  return {repo, manager, run, finish: async () => { await manager.shutdown(); await rm(root, {recursive: true, force: true}); }};
}

test('the owner\'s setup commands run in the new worktree, in order, before the agent, and are recorded on the task', async () => {
  const {repo, run, finish} = await setup([
    node("require('fs').writeFileSync('prepared.txt', 'one')"),
    node("const fs=require('fs'); fs.appendFileSync('prepared.txt', '+two'); console.log('setup says hi')")
  ]);
  try {
    const done = await run();
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(await readFile(path.join(done.worktree!, 'prepared.txt'), 'utf8'), 'one+two');
    assert.equal(await readFile(path.join(done.worktree!, 'a.txt'), 'utf8'), 'edited by codex\n', 'the agent still ran, with its prompt on stdin');
    assert.equal(existsSync(path.join(repo, 'prepared.txt')), false, 'the owner\'s checkout is not touched');
    assert.equal(done.setup?.ok, true);
    assert.equal(done.setup?.commands.length, 2);
    assert.match(done.setup?.commands[1]!.output_tail ?? '', /setup says hi/);
    assert.deepEqual(done.scope?.out_of_scope, []);
    assert.doesNotMatch(done.stdout, /setup says hi/, 'setup output never reaches the stdout the agent result is parsed from');
  } finally { await finish(); }
});

test('a failing setup command stops the task before the agent runs, and is not mistaken for an agent failure', async () => {
  const {run, finish} = await setup([node("console.error('lockfile out of date'); process.exit(4)"), node("require('fs').writeFileSync('prepared.txt', 'x')")]);
  try {
    const done = await run();
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /Worktree setup failed before the agent started: .* exited 4/);
    assert.equal(done.setup?.ok, false);
    assert.equal(done.setup?.commands.length, 1, 'the commands after the failure did not run');
    assert.match(done.setup?.commands[0]!.output_tail ?? '', /lockfile out of date/);
    assert.equal(await readFile(path.join(done.worktree!, 'a.txt'), 'utf8'), 'base\n', 'the agent never started');
  } finally { await finish(); }
});

test('setup has its own time limit and a missing command is reported by name', async () => {
  const slow = await setup([node('setTimeout(() => {}, 60000)')], 1);
  try {
    const done = await slow.run();
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /was stopped .*time limit is 1s/);
  } finally { await slow.finish(); }
  const missing = await setup([['no-such-setup-command-xyz', 'install']]);
  try {
    const done = await missing.run();
    assert.equal(done.status, 'failed');
    assert.match(done.error ?? '', /no-such-setup-command-xyz install" could not run: Command not found/);
  } finally { await missing.finish(); }
});

test('a task without a worktree runs no setup', async () => {
  const {repo, run, finish} = await setup([node("require('fs').writeFileSync('prepared.txt', 'x')")]);
  try {
    const done = await run('none');
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.setup, undefined);
    assert.equal(existsSync(path.join(repo, 'prepared.txt')), false);
  } finally { await finish(); }
});
