import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { claudeAdapter, claudeBashRule } from '../src/agents/claude.js';
import { createAgentRegistry } from '../src/agents/registry.js';
import { elevationFamily, elevationOptions, elevationRefusal, parseElevation } from '../src/approvals.js';
import { TaskManager } from '../src/tasks/manager.js';
import type { Config } from '../src/config.js';
import type { AgentRuntime, AgentTask, RawRun } from '../src/agents/types.js';

const command = {executable: 'claude', prefixArgs: [], source: 'claude'};
const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  prompt: '-starts with a dash\nsecond line', workspace: path.join(tmpdir(), 'ws'), timeoutSeconds: 60, autonomy: 'auto',
  owns: [], taskId: 't1', stateDirectory: tmpdir(), ...extra
});
const raw = (stdout: string, extra: Partial<RawRun> = {}): RawRun => ({stdout, stderr: '', exitCode: 0, signal: null, resultFile: null, ...extra});
const SESSION = 'f5b2a9d3-0049-4f68-8133-89132bd66aab';
// Trimmed from real `claude -p --output-format json` results on 2.1.319.
const result = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'DONE', num_turns: 4, duration_ms: 3052,
  session_id: SESSION, total_cost_usd: 0.095, permission_denials: [],
  usage: {input_tokens: 2, cache_creation_input_tokens: 11224, cache_read_input_tokens: 26220, output_tokens: 4, iterations: [{input_tokens: 2}]},
  ...extra
});
const DENIED_BASH = {tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {command: 'node -e "require(\\"fs\\").writeFileSync(\\"n.txt\\",\\"1\\")"', description: 'Write n.txt'}};
const DENIED_WRITE = {tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: {file_path: '/elsewhere/o.txt', content: '1'}};

test('claude invocation: print mode, JSON result, owner permission mode, no repository settings or MCP servers, prompt on stdin', () => {
  const invocation = claudeAdapter(command, {permissionPrompts: true}).buildInvocation(task());
  assert.deepEqual(invocation.args, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--setting-sources', 'user', '--strict-mcp-config', '--permission-prompts', 'none']);
  assert.equal(invocation.stdin, '-starts with a dash\nsecond line\n');
  assert.equal(invocation.resultFile, undefined);
  assert.ok(!claudeAdapter(command).buildInvocation(task()).args.includes('--permission-prompts'), 'a CLI without the flag is not handed it');
});

test('claude: a task\'s autonomy never reaches a permission flag, and a task cannot choose the model', () => {
  for (const autonomy of ['suggest', 'auto', 'full'] as const) {
    const args = claudeAdapter(command).buildInvocation(task({autonomy, model: 'from-the-task'})).args;
    assert.ok(!args.includes('bypassPermissions') && !args.includes('--dangerously-skip-permissions'), autonomy);
    assert.ok(!args.includes('from-the-task'));
  }
  const owned = claudeAdapter(command, {model: 'claude-sonnet-5-5', permissionMode: 'plan', maxBudgetUsd: 2.5, env: {CLAUDE_CONFIG_DIR: '/acct2'}}).buildInvocation(task());
  assert.deepEqual(owned.args.slice(4, 5), ['plan']);
  assert.deepEqual(owned.args.slice(-4), ['--model', 'claude-sonnet-5-5', '--max-budget-usd', '2.5']);
  assert.deepEqual(owned.customEnv, {CLAUDE_CONFIG_DIR: '/acct2'});
});

test('claude: resume and one-run grants are appended last, one value each', () => {
  const resumed = claudeAdapter(command).buildInvocation(task({conversationId: SESSION})).args;
  assert.deepEqual(resumed.slice(-2), ['--resume', SESSION]);
  const bash = claudeAdapter(command).buildInvocation(task({elevation: {kind: 'claude-allow-bash', rule: 'Bash(npm test)'}})).args;
  assert.deepEqual(bash.slice(-2), ['--allowedTools', 'Bash(npm test)']);
  const dir = claudeAdapter(command).buildInvocation(task({elevation: {kind: 'claude-add-dir', dir: '/data/out'}})).args;
  assert.deepEqual(dir.slice(-2), ['--add-dir', '/data/out']);
  // The launcher prepends a Windows shim's entry script; the adapter must not add it a second time.
  assert.equal(claudeAdapter({executable: 'node', prefixArgs: ['cli.js'], source: 'claude'}).buildInvocation(task()).args[0], '-p');
});

test('claude: a successful result gives the answer, the session to resume, turns and usage including cost', async () => {
  const parsed = await claudeAdapter(command).parseResult(raw(`${result()}\n`));
  assert.equal(parsed.success, true);
  assert.equal(parsed.response, 'DONE');
  assert.equal(parsed.conversationId, SESSION);
  assert.equal(parsed.numTurns, 4);
  assert.deepEqual(parsed.stats, {
    usage: {input_tokens: 2, cache_creation_input_tokens: 11224, cache_read_input_tokens: 26220, output_tokens: 4, total_cost_usd: 0.095},
    agy_duration_seconds: 3.052, num_turns: 4, steps: null
  });
});

test('claude: a refused tool call fails the task and is listed with what it tried to do', async () => {
  const parsed = await claudeAdapter(command).parseResult(raw(result({result: 'DENIED', permission_denials: [DENIED_BASH, DENIED_WRITE, DENIED_BASH]})));
  assert.equal(parsed.success, false);
  assert.match(parsed.error ?? '', /refused a tool call/);
  assert.deepEqual(parsed.deniedActions, [
    {action: 'Bash', display_name: 'Bash: node -e "require(\\"fs\\").writeFileSync(\\"n.txt\\",\\"1\\")"'},
    {action: 'Write', display_name: 'Write: /elsewhere/o.txt'}
  ]);
  assert.equal(parsed.conversationId, SESSION, 'the session still exists, so a correction can continue it');
});

test('claude: an API error is a failure, and only a rate/usage limit is a quota hit', async () => {
  const model = await claudeAdapter(command).parseResult(raw(result({is_error: true, api_error_status: 404, result: 'There\'s an issue with the selected model (no-such-model-xyz).'}), {exitCode: 1}));
  assert.equal(model.success, false);
  assert.match(model.error ?? '', /selected model/);
  assert.equal(model.isQuotaExceeded, false);
  const limited = await claudeAdapter(command).parseResult(raw(result({is_error: true, api_error_status: 429, result: 'API Error'}), {exitCode: 1}));
  assert.equal(limited.isQuotaExceeded, true);
  assert.equal(limited.cliStatus, 'quota_exceeded');
  const usage = await claudeAdapter(command).parseResult(raw(result({is_error: true, result: 'Claude AI usage limit reached|1767000000'}), {exitCode: 1}));
  assert.equal(usage.isQuotaExceeded, true);
  const mentions = await claudeAdapter(command).parseResult(raw(result({result: 'Added handling for 429 Too many requests responses.'})));
  assert.equal(mentions.success, true, 'an answer that mentions a rate limit is not a quota failure');
  assert.notEqual(mentions.isQuotaExceeded, true);
});

test('claude: no result object falls back to stderr, the exit code, or the signal', async () => {
  const lost = await claudeAdapter(command).parseResult(raw('', {exitCode: 1, stderr: `No conversation found with session ID: ${SESSION}\n`}));
  assert.equal(lost.success, false);
  assert.match(lost.error ?? '', /No conversation found/);
  assert.equal((await claudeAdapter(command).parseResult(raw('', {exitCode: 3}))).error, 'Claude Code exited 3');
  assert.match((await claudeAdapter(command).parseResult(raw('', {exitCode: null, signal: 'SIGTERM'}))).error ?? '', /terminated \(SIGTERM\)/);
  const empty = await claudeAdapter(command).parseResult(raw(result({result: ''})));
  assert.equal(empty.success, false);
  assert.equal(empty.error, 'Claude Code did not provide a final message');
});

test('claude approvals: the exact refused command, or one directory for a refused file tool; nothing wider', () => {
  const denied = [{action: 'Bash', display_name: 'Bash: npm test'}, {action: 'Write', display_name: 'Write: /elsewhere/o.txt'}];
  const options = elevationOptions('claude', denied);
  assert.deepEqual(options.map(option => [option.kind, option.elevation, option.needs_dir, option.narrowest, option.wide]), [
    ['claude-allow-bash', {kind: 'claude-allow-bash', rule: 'Bash(npm test)'}, false, true, false],
    ['claude-add-dir', null, true, false, false]
  ]);
  assert.equal(elevationRefusal('claude', denied, {kind: 'claude-allow-bash', rule: 'Bash(npm test)'}), null);
  assert.match(elevationRefusal('claude', denied, {kind: 'claude-allow-bash', rule: 'Bash(rm -rf /)'}) ?? '', /not refused that command/);
  assert.match(elevationRefusal('claude', denied, {kind: 'claude-add-dir', dir: 'relative'}) ?? '', /absolute/);
  assert.match(elevationRefusal('claude', denied, {kind: 'codex-add-dir', dir: '/x'}) ?? '', /cannot be given/);
  assert.equal(elevationFamily(parseElevation({kind: 'claude-add-dir', dir: '/x'})), 'claude');
  assert.equal(claudeBashRule({action: 'Bash', display_name: 'Bash: echo a\necho b'}), null, 'a multi-line command has no exact rule');
  assert.equal(claudeBashRule({action: 'Write', display_name: 'Write: /x'}), null);
});

function fakeClaude(onArgs: (args: string[]) => void, stdout: () => string): AgentRuntime {
  return {
    adapter: claudeAdapter(command, {permissionPrompts: true}),
    status: {id: 'claude', label: 'Claude Code', available: true, version: '2.1.319', executable: 'claude', capabilities: ['code'], warnings: [], conversation_resume: true},
    enabled: true,
    launch: (args: string[]) => {
      onArgs(args);
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 910_101; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      setTimeout(() => { child.stdout.end(`${stdout()}\n`); child.emit('close', 0, null); }, 10);
      return child as unknown as ChildProcess;
    }
  };
}

test('a Claude Code task records its session, and a correction continues it with --resume; another family cannot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-claude-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const seen: string[][] = [];
  const claude = fakeClaude(args => seen.push(args), () => result());
  const other: AgentRuntime = {...fakeClaude(() => {}, () => result()), adapter: {...claudeAdapter(command), id: 'opencode', family: 'opencode'},
    status: {id: 'opencode', label: 'OpenCode', available: true, version: '2.2.5', executable: 'opencode', capabilities: ['code'], warnings: []}};
  const config = {allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 65536,
    max_retained_tasks: 10, max_queued_tasks: 0, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'} as unknown as Config;
  const manager = new TaskManager(config, {executable: 'claude', supported: true, stateDirectory: path.join(root, 'state'), agents: [claude, other], defaultAgent: 'claude'});
  try {
    const first = await manager.wait((await manager.delegate({task: 'do it', workspace, acceptance_criteria: ['done'], agent: 'claude'})).task_id);
    assert.equal(first.status, 'completed', first.error ?? '');
    assert.equal(first.conversation_id, SESSION);
    const second = await manager.wait((await manager.delegate({task: 'fix the note', workspace, acceptance_criteria: ['done'], agent: 'claude', resume_conversation: SESSION})).task_id);
    assert.equal(second.status, 'completed', second.error ?? '');
    assert.deepEqual(seen[1]!.slice(-2), ['--resume', SESSION]);
    assert.ok(!seen[0]!.includes('--resume'));
    await assert.rejects(() => manager.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], agent: 'opencode', resume_conversation: SESSION}), /needs Antigravity or Claude Code/);
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('Claude Code is opt-in; a missing CLI is reported, and bypassPermissions is a visible warning', async () => {
  const base: Config = {
    allowed_workspaces: [], executable: 'agy', max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144,
    max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const inspection = {executable: 'agy', supported: true, version: '1.4.7', warnings: []};
  const off = await createAgentRegistry(base, inspection);
  const absent = off.agents.find(agent => agent.adapter.id === 'claude')!;
  assert.equal(absent.enabled, false);
  assert.deepEqual(absent.status.warnings, ['Disabled in the bridge config']);
  const on = await createAgentRegistry({...base, agents: {enabled: ['claude', 'claude-2'], claude_executable: 'no-such-claude-cli', claude_permission_mode: 'bypassPermissions',
    profiles: {'claude-2': {adapter: 'claude', env: {CLAUDE_CONFIG_DIR: '/acct2'}, claude_permission_mode: 'acceptEdits'}}}}, inspection);
  const claude = on.agents.find(agent => agent.adapter.id === 'claude')!;
  assert.equal(claude.status.available, false);
  assert.ok(claude.status.warnings.some(w => /Claude Code CLI not found/.test(w)));
  assert.ok(claude.status.warnings.some(w => /bypassPermissions/.test(w)));
  const profile = on.agents.find(agent => agent.adapter.id === 'claude-2')!;
  assert.equal(profile.adapter.family, 'claude');
  assert.equal(profile.status.available, false);
  assert.ok(!profile.status.warnings.some(w => /bypassPermissions/.test(w)), 'the profile overrides the mode, so it carries no danger warning');
  assert.ok(on.warnings.some(w => /"claude" is configured with dangerous permissions/.test(w)));
});
