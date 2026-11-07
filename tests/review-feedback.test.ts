import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { claudeAdapter } from '../src/agents/claude.js';
import type { AgentRuntime } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { readDecisions } from '../src/decisions.js';
import { feedbackTask, quoteNote } from '../src/review/feedback.js';
import { TaskManager } from '../src/tasks/manager.js';

const SESSION = '0b8a3a8e-6f1e-4d2a-9b55-2d1f7c9e4a10';
const git = (cwd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
  });
});

interface Run { args: string[]; cwd: string; prompt: string; before: string | null; }

/** A Claude Code stand-in: each run records how it was launched and what a.txt held when it started, then writes the next scripted content. */
function scriptedClaude(contents: string[], runs: Run[]): AgentRuntime {
  return {
    adapter: claudeAdapter({executable: 'claude', prefixArgs: [], source: 'claude'}),
    status: {id: 'claude', label: 'Claude Code', available: true, version: '2.1.319', executable: 'claude', capabilities: ['code'], warnings: [], conversation_resume: true},
    enabled: true,
    launch: (args, cwd, options) => {
      const file = path.join(cwd, 'a.txt');
      runs.push({args, cwd, prompt: options?.stdin ?? '', before: existsSync(file) ? readFileSync(file, 'utf8') : null});
      const next = contents[runs.length - 1];
      if (next !== undefined) writeFileSync(file, next);
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 920_000 + runs.length; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      setTimeout(() => {
        child.stdout.end(`${JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'Changed a.txt', num_turns: 2, session_id: SESSION, permission_denials: []})}\n`);
        child.emit('close', 0, null);
      }, 10);
      return child as unknown as ChildProcess;
    }
  };
}

async function setup(contents: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-feedback-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  await writeFile(path.join(repo, 'b.txt'), 'other\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const config: Config = {
    allowed_workspaces: [repo], executable: 'claude', max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const runs: Run[] = [];
  const state = path.join(root, 'state');
  const manager = new TaskManager(config, {executable: 'claude', supported: true, stateDirectory: state, agents: [scriptedClaude(contents, runs)], defaultAgent: 'claude'});
  const finish = async () => { await manager.shutdown(); await rm(root, {recursive: true, force: true}); };
  return {repo, state, manager, runs, finish};
}

test('review notes on a worktree task become one follow-up that starts from its changes, quotes the lines and continues the session', async () => {
  const {repo, state, manager, runs, finish} = await setup(['one\nTWO\nthree\nfour\n', 'one\ntwo, fixed\nthree\nfour\n']);
  try {
    const first = await manager.wait((await manager.delegate({task: 'Rename line two', workspace: repo, acceptance_criteria: ['line two renamed'], agent: 'claude', isolation: 'worktree', owns: ['a.txt']})).task_id);
    assert.equal(first.status, 'completed', first.error ?? '');
    const follow = await manager.feedback({task_id: first.task_id, notes: [{path: 'a.txt', line: 2, note: 'keep it lowercase and add ", fixed"'}], instruction: 'Touch nothing else'});
    assert.equal(follow.feedback_of, first.task_id);
    const done = await manager.wait(follow.task_id);
    assert.equal(done.status, 'completed', done.error ?? '');

    const run = runs[1]!;
    assert.notEqual(run.cwd, runs[0]!.cwd, 'the follow-up has a worktree of its own');
    assert.equal(run.before, 'one\nTWO\nthree\nfour\n', 'the reviewed changes were already there when the agent started');
    assert.deepEqual(run.args.slice(-2), ['--resume', SESSION], 'the agent continues the conversation that wrote the code');
    assert.match(run.prompt, /a\.txt:2: keep it lowercase and add \\", fixed\\"/);
    assert.match(run.prompt, />\s+2 \| TWO/, 'the noted line is quoted as it is on disk');
    assert.match(run.prompt, /Touch nothing else/);
    assert.match(run.prompt, /Rename line two/, 'the original task travels with the notes');

    assert.deepEqual(manager.get(first.task_id).feedback_tasks, [follow.task_id]);
    const detail = manager.detail(follow.task_id);
    assert.equal(detail.request?.feedback?.of, first.task_id);
    assert.equal(detail.request?.feedback?.carried_files, 1);

    // The follow-up's diff is the whole result: applying it alone gives the workspace both rounds.
    await manager.applyTask(follow.task_id);
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'one\ntwo, fixed\nthree\nfour\n');
    assert.ok((await readDecisions(state)).some(entry => entry.action === 'feedback' && entry.task_id === first.task_id && entry.ok));
    // An applied task has left its worktree's story; further notes go to a task in the workspace.
    await assert.rejects(manager.feedback({task_id: follow.task_id, notes: [{path: 'a.txt', note: 'again'}]}), /already applied/);
  } finally { await finish(); }
});

test('notes are refused when the follow-up could not act on them', async () => {
  const {repo, manager, runs, finish} = await setup(['one\nTWO\nthree\nfour\n']);
  try {
    const first = await manager.wait((await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'claude', isolation: 'worktree', owns: ['a.txt']})).task_id);
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: [{path: 'b.txt', line: 1, note: 'x'}]}), /does not own.*: b\.txt/);
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: [{path: 'a.txt', line: 99, note: 'x'}]}), /past the end of the file/);
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: [{path: '../a.txt', note: 'x'}]}), /relative path inside/);
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: [{path: 'a.txt', line: 3, end_line: 2, note: 'x'}]}));
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: []}));
    await assert.rejects(manager.feedback({task_id: '00000000-0000-4000-8000-000000000000', notes: [{path: 'a.txt', note: 'x'}]}), /Unknown or expired/);
    await manager.discardTask(first.task_id);
    await assert.rejects(manager.feedback({task_id: first.task_id, notes: [{path: 'a.txt', note: 'x'}]}), /discarded/);
    assert.equal(runs.length, 1, 'no refused note started an agent');
  } finally { await finish(); }
});

test('a task without a worktree gets its follow-up in the same workspace', async () => {
  const {repo, manager, runs, finish} = await setup(['one\nTWO\nthree\nfour\n', 'one\ntwo\nthree\nfour\n']);
  try {
    const first = await manager.wait((await manager.delegate({task: 'edit', workspace: repo, acceptance_criteria: ['ok'], agent: 'claude'})).task_id);
    const done = await manager.wait((await manager.feedback({task_id: first.task_id, notes: [{path: 'a.txt', line: 2, note: 'undo the caps'}]})).task_id);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(runs[1]!.cwd, runs[0]!.cwd);
    assert.equal(done.isolation, 'none');
    assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\n');
  } finally { await finish(); }
});

test('quoted lines show their numbers and mark the noted range; the prompt stays inside the delegate limit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-quote-'));
  try {
    await writeFile(path.join(root, 'f.ts'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'));
    const quoted = await quoteNote(root, {path: 'f.ts', line: 3, end_line: 4, note: 'merge these'});
    assert.equal(quoted.excerpt, ['  1 | a', '  2 | b', '> 3 | c', '> 4 | d', '  5 | e', '  6 | f'].join('\n'));
    assert.equal((await quoteNote(root, {path: 'gone.ts', line: 1, note: 'x'})).missing, true);
    assert.equal((await quoteNote(root, {path: 'f.ts', note: 'whole file'})).excerpt, null);
    const text = feedbackTask('id', 'x'.repeat(20_000), Array.from({length: 30}, () => ({...quoted, note: 'n'.repeat(2000)})));
    assert.ok(text.length <= 16_000);
  } finally { await rm(root, {recursive: true, force: true}); }
});
