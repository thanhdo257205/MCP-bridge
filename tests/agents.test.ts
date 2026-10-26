import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand } from '../src/antigravity/process.js';
import { codexAdapter, codexAgent } from '../src/agents/codex.js';
import type { AgentStatus } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { createWorktree, inspectScope } from '../src/isolation/worktree.js';
import { delegateSchema } from '../src/security/input.js';
import { inside } from '../src/security/workspace.js';
import { TaskManager } from '../src/tasks/manager.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-codex.mjs', import.meta.url));
const codexStatus: AgentStatus = {
  id: 'codex', label: 'Codex', available: true, version: 'fake', executable: 'fixture',
  capabilities: ['code', 'review', 'test', 'research', 'long-run'], warnings: []
};
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-agents-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init']);
  return {root, repo, state: path.join(root, 'state')};
}
function configFor(repo: string, worktrees = 2): Config {
  return {
    allowed_workspaces: [repo], executable: process.execPath,
    max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: worktrees, default_autonomy: 'auto',
    extra_env_passthrough: [], prompt_transport: 'argv'
  };
}

test('delegate schema applies defaults and requires owns only for worktree isolation', () => {
  const base = {task: 'x', workspace: 'C:/work', acceptance_criteria: ['ok']};
  const plain = delegateSchema.safeParse(base);
  assert.equal(plain.success, true);
  if (plain.success) assert.deepEqual([plain.data.isolation, plain.data.owns], ['none', []]);
  assert.equal(delegateSchema.safeParse({...base, isolation: 'worktree'}).success, false);
  assert.equal(delegateSchema.safeParse({...base, owns: ['src']}).success, false);
  assert.equal(delegateSchema.safeParse({...base, isolation: 'worktree', owns: ['src']}).success, true);
  for (const owns of [['../escape'], ['/absolute'], ['C:\\absolute'], ['.'], ['a/../../b'], ['']]) {
    assert.equal(delegateSchema.safeParse({...base, isolation: 'worktree', owns}).success, false, JSON.stringify(owns));
  }
});

test('Windows .cmd shims resolve to a local Node entry without a shell', {skip: process.platform !== 'win32'}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-shim-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const script = path.join(bin, 'fake-cli.js');
    await writeFile(script, 'process.stdout.write("ok");\n');
    const shim = path.join(bin, 'fake-cli.cmd');
    await writeFile(shim, '@ECHO off\r\n"%~dp0\\fake-cli.js" %*\r\n');
    const resolved = await resolveCommand(shim);
    assert.equal(resolved.executable, process.execPath);
    assert.deepEqual(resolved.prefixArgs, [await realpath(script)]);
    assert.equal(resolved.source, await realpath(shim));

    const outside = path.join(root, 'outside.js');
    await writeFile(outside, '');
    const escaping = path.join(bin, 'escaping.cmd');
    await writeFile(escaping, '@"%~dp0\\..\\outside.js" %*\r\n');
    await assert.rejects(resolveCommand(escaping), /Unsupported \.cmd shim/);
    await assert.rejects(resolveCommand(path.join(root, 'missing')), /Command not found/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Codex adapter sends the prompt on stdin, uses exec flags, and prefers the last-message file', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'agy-codex-'));
  const taskId = '11111111-1111-4111-8111-111111111111';
  try {
    const adapter = codexAdapter({executable: 'codex', prefixArgs: [], source: 'codex'}, {model: 'gpt-test'});
    const invocation = adapter.buildInvocation({
      prompt: 'do the task', workspace: path.join(state, 'work'), timeoutSeconds: 10,
      autonomy: 'auto', owns: [], taskId, stateDirectory: state
    });
    assert.equal(invocation.executable, 'codex');
    assert.equal(invocation.stdin, 'do the task\n');
    const args = invocation.args;
    assert.deepEqual(args.slice(0, 8), ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--cd', path.join(state, 'work')]);
    assert.deepEqual(args.slice(-7), ['--color', 'never', '-o', path.join(state, 'results', `${taskId}.txt`), '-m', 'gpt-test', '-']);
    assert.equal(invocation.resultFile, path.join(state, 'results', `${taskId}.txt`));

    await mkdir(path.join(state, 'results'), {recursive: true});
    await writeFile(invocation.resultFile!, '  final codex answer  \n');
    const completed = await adapter.parseResult({
      stdout: 'non-json diagnostic\n{"type":"turn.completed","status":"completed"}\n', stderr: '', exitCode: 0, signal: null,
      resultFile: invocation.resultFile
    });
    assert.equal(completed.success, true);
    assert.equal(completed.response?.trim(), 'final codex answer');
    assert.equal(completed.cliStatus, 'completed');
    assert.equal(completed.numTurns, 1);

    const fromStream = await adapter.parseResult({
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"stream answer"}}\n',
      stderr: '', exitCode: 0, signal: null, resultFile: null
    });
    assert.equal(fromStream.success, true);
    assert.equal(fromStream.response, 'stream answer');

    const failed = await adapter.parseResult({
      stdout: '{"type":"error","message":"deliberate codex failure"}\n', stderr: 'stderr tail', exitCode: 3, signal: null, resultFile: null
    });
    assert.equal(failed.success, false);
    assert.equal(failed.error, 'deliberate codex failure');

    const denied = await adapter.parseResult({
      stdout: '{"type":"item.completed","item":{"type":"command_execution","status":"declined","command":"rm -rf build"}}\n',
      stderr: '', exitCode: 0, signal: null, resultFile: invocation.resultFile
    });
    assert.equal(denied.success, false);
    assert.equal(denied.deniedActions[0].display_name, 'rm -rf build');
    assert.match(String(denied.error), /denied action/);
  } finally {
    await rm(state, {recursive: true, force: true});
  }
});

test('TaskManager runs the requested Codex agent and exposes its status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-codex-run-'));
  const workspace = path.join(root, 'work');
  await mkdir(workspace);
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'ok'], source: 'fixture'}, codexStatus);
  const manager = new TaskManager(configFor(workspace), {
    executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'codex'
  });
  try {
    const overview = manager.agentsOverview();
    assert.deepEqual(overview.agents.map(item => [item.id, item.available, item.enabled]), [['codex', true, true]]);
    assert.equal(overview.default_agent, 'codex');
    assert.equal(overview.max_parallel_worktrees, 2);
    await assert.rejects(manager.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], agent: 'missing'}), /Unknown agent/);
    const started = await manager.delegate({task: 'edit', workspace, acceptance_criteria: ['ok'], agent: 'codex'});
    const done = await manager.wait(started.task_id);
    assert.equal(done.status, 'completed');
    assert.equal(done.agent, 'codex');
    assert.equal(done.final_response?.trim(), 'codex implemented');
    assert.equal(done.isolation, 'none');
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('worktree tasks run in parallel, keep separate branches and report in-scope changes', async () => {
  const {root, repo, state} = await repository();
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'write', 'scope', '800'], source: 'fixture'}, codexStatus);
  const manager = new TaskManager(configFor(repo), {
    executable: process.execPath, supported: true, stateDirectory: state, agents: [agent], defaultAgent: 'codex'
  });
  try {
    const first = await manager.delegate({task: 'edit a', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation: 'worktree', owns: ['a.txt']});
    const second = await manager.delegate({task: 'edit b', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation: 'worktree', owns: ['b.txt']});
    assert.equal(first.status, 'running');
    assert.equal(second.status, 'running', 'worktree lane allows a second task without queuing');
    assert.notEqual(first.worktree, second.worktree);
    assert.ok(first.worktree && inside(state, first.worktree));
    assert.match(String(first.branch), new RegExp(`^bridge/${first.task_id}$`));

    const [doneA, doneB] = await Promise.all([manager.wait(first.task_id), manager.wait(second.task_id)]);
    for (const done of [doneA, doneB]) {
      assert.equal(done.status, 'completed');
      assert.deepEqual(done.scope, {checked: true, changed: 1, out_of_scope: [], truncated: false});
    }
    assert.equal(await readFile(path.join(doneA.worktree!, 'a.txt'), 'utf8'), 'edited by codex\n');
    const detail = manager.detail(first.task_id);
    assert.ok(detail.prompt?.includes(doneA.worktree!), 'regenerated prompt uses the worktree workspace');
    assert.equal(detail.request?.branch, doneA.branch);
    const branches = await git(repo, ['branch', '--list', 'bridge/*']);
    assert.ok(branches.includes(`bridge/${first.task_id}`));
    assert.ok(branches.includes(`bridge/${second.task_id}`));
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('changes outside the declared owns scope complete but require review', async () => {
  const {root, repo, state} = await repository();
  const agent = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'write', 'stray.txt'], source: 'fixture'}, codexStatus);
  const manager = new TaskManager(configFor(repo), {
    executable: process.execPath, supported: true, stateDirectory: state, agents: [agent], defaultAgent: 'codex'
  });
  try {
    const started = await manager.delegate({task: 'stay in scope', workspace: repo, acceptance_criteria: ['ok'], agent: 'codex', isolation: 'worktree', owns: ['only.txt']});
    const done = await manager.wait(started.task_id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.scope?.out_of_scope, ['stray.txt']);
    assert.match(String(done.error), /outside the declared owns scope/);
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('a disabled or unavailable agent is refused instead of silently falling back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-agent-off-'));
  const workspace = path.join(root, 'work');
  await mkdir(workspace);
  const base = codexAgent({executable: process.execPath, prefixArgs: [fixture, 'ok'], source: 'fixture'}, codexStatus);
  const disabled = new TaskManager(configFor(workspace), {
    executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state'), agents: [{...base, enabled: false}], defaultAgent: 'codex'
  });
  const unavailable = new TaskManager(configFor(workspace), {
    executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state-2'), agents: [{...base, status: {...codexStatus, available: false}}], defaultAgent: 'codex'
  });
  try {
    await assert.rejects(disabled.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], agent: 'codex'}), /disabled/);
    assert.equal((await disabled.delegate({task: 'x', workspace, acceptance_criteria: ['ok']})).status, 'unsupported');
    await assert.rejects(unavailable.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], agent: 'codex'}), /not available/);
  } finally {
    await disabled.shutdown();
    await unavailable.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('createWorktree refuses a directory that is not a git repository and inspectScope reports its reason', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-worktree-'));
  try {
    await assert.rejects(createWorktree({workspace: root, stateDirectory: path.join(root, 'state'), taskId: 'x'}), /git repository with at least one commit/);
    const report = await inspectScope({
      root, workspace: root, toplevel: root, branch: 'bridge/x', prefix: '', base: 'HEAD'
    }, ['src']);
    assert.equal(report.checked, false);
    assert.ok(report.reason);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
