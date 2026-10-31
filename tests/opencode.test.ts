import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { opencodeAdapter } from '../src/agents/opencode.js';
import { createAgentRegistry } from '../src/agents/registry.js';
import { TaskManager } from '../src/tasks/manager.js';
import type { Config } from '../src/config.js';
import type { AgentRuntime, AgentTask, RawRun } from '../src/agents/types.js';

const command = {executable: 'opencode', prefixArgs: [], source: 'opencode'};
const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  prompt: 'fix the bug\n- keep the second line', workspace: 'C:\\w', timeoutSeconds: 60, autonomy: 'auto',
  owns: [], taskId: 't1', stateDirectory: 'C:\\s', ...extra
});
const raw = (stdout: string, extra: Partial<RawRun> = {}): RawRun => ({stdout, stderr: '', exitCode: 0, signal: null, resultFile: null, ...extra});
const event = (type: string, part: Record<string, unknown>) => JSON.stringify({type, part});
const text = (value: string) => event('text', {type: 'text', text: value});
const finish = (reason: string, input = 10, output = 2) => event('step_finish', {type: 'step-finish', reason, tokens: {input, output}});

test('opencode invocation puts run flags after the subcommand and sends the prompt on stdin untouched', () => {
  const invocation = opencodeAdapter(command, {model: 'opencode/big-pickle'}).buildInvocation(task());
  assert.deepEqual(invocation.args, ['run', '--standalone', '--format', 'json', '--model', 'opencode/big-pickle']);
  assert.equal(invocation.stdin, 'fix the bug\n- keep the second line\n');
  assert.equal(invocation.transport, undefined);
});

test('opencode invocation prefers the task model, and only the owner option adds --auto, never a task\'s autonomy', () => {
  assert.deepEqual(opencodeAdapter(command, {model: 'a/b'}).buildInvocation(task({model: 'c/d'})).args.slice(-2), ['--model', 'c/d']);
  for (const autonomy of ['suggest', 'auto', 'full'] as const) {
    assert.ok(!opencodeAdapter(command).buildInvocation(task({autonomy})).args.includes('--auto'), `autonomy ${autonomy} is an instruction, not a permission grant`);
  }
  assert.ok(opencodeAdapter(command, {autoApprove: true}).buildInvocation(task({autonomy: 'suggest'})).args.includes('--auto'));
});

test('opencode drops tool payloads from the kept log but leaves everything parseResult reads untouched', async () => {
  const adapter = opencodeAdapter(command);
  const compact = adapter.compactLine!.bind(adapter);
  const big = 'x'.repeat(50_000);
  const toolEvent = JSON.stringify({type: 'tool_use', part: {tool: 'read', state: {status: 'completed', output: big}}});
  assert.deepEqual(JSON.parse(compact(toolEvent)!), {type: 'tool_use', part: {tool: 'read', state: {status: 'completed'}}});
  assert.equal(compact(event('step_start', {})), null);
  for (const kept of [text('answer'), finish('stop'), JSON.stringify({type: 'error', error: {message: 'boom'}})]) assert.equal(compact(kept), kept);
  assert.equal(compact('not json'), 'not json');
  assert.equal(compact('null'), 'null');
  assert.equal(compact(JSON.stringify({type: 'something-new', blob: big})), JSON.stringify({type: 'something-new'}));
  // The result computed from the compacted stream is the one computed from the full stream.
  const stream = [event('step_start', {}), toolEvent, text('done'), finish('stop', 7, 3)];
  const compacted = stream.map(compact).filter((line): line is string => line !== null).join('\n');
  const [full, small] = await Promise.all([adapter.parseResult(raw(stream.join('\n'))), adapter.parseResult(raw(compacted))]);
  assert.deepEqual(small, full);
});

test('a task whose tool events dwarf the output cap still completes, because only the compacted log is counted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-oc-cap-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const big = 'x'.repeat(2000);
  const tools = Array.from({length: 40}, () => event('tool_use', {tool: 'read', state: {status: 'completed', output: big}}));
  const agent: AgentRuntime = {
    adapter: opencodeAdapter(command),
    status: {id: 'opencode', label: 'OpenCode', available: true, version: '2.2.5', executable: 'opencode', capabilities: ['code'], warnings: []},
    enabled: true,
    launch: () => {
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 910_002; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      setTimeout(() => { child.stdout.end(`${[...tools, text('all done'), finish('stop')].join('\n')}\n`); child.emit('close', 0, null); }, 10);
      return child as unknown as ChildProcess;
    }
  };
  // 80 KB of tool events against a 4 KB cap: without compaction this task is cancelled for exceeding it.
  const config = {allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 4096,
    max_retained_tasks: 10, max_queued_tasks: 0, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'} as unknown as Config;
  const manager = new TaskManager(config, {executable: 'opencode', supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'opencode'});
  try {
    const started = await manager.delegate({task: 'do the work', workspace, acceptance_criteria: ['done'], agent: 'opencode'});
    const done = await manager.wait(started.task_id);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(done.final_response, 'all done');
    assert.equal(done.stdout_truncated, false);
    assert.ok(done.stdout_bytes > 40 * 2000, 'the raw stream really was far above the cap');
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('opencode keeps the profile env and the resolved prefix args', () => {
  const invocation = opencodeAdapter({executable: 'node', prefixArgs: ['oc.js'], source: 'x'}, {env: {XDG_DATA_HOME: 'D:\\d'}}).buildInvocation(task());
  assert.deepEqual(invocation.args.slice(0, 2), ['oc.js', 'run']);
  assert.deepEqual(invocation.customEnv, {XDG_DATA_HOME: 'D:\\d'});
});

test('opencode takes the last text event as the answer and reports turns and tokens', async () => {
  const stdout = [event('step_start', {}), text('I will create the file.'), finish('tool-calls', 100, 5), event('step_start', {}), text('done'), finish('stop', 50, 1)].join('\n');
  const result = await opencodeAdapter(command).parseResult(raw(stdout));
  assert.equal(result.success, true);
  assert.equal(result.response, 'done');
  assert.equal(result.numTurns, 2);
  assert.equal(result.cliStatus, 'stop');
  assert.deepEqual(result.stats?.usage, {input_tokens: 150, output_tokens: 6});
});

test('opencode ignores non-JSON lines in the stream', async () => {
  const result = await opencodeAdapter(command).parseResult(raw(['warning: something', text('ok'), '42', 'null', finish('stop')].join('\n')));
  assert.equal(result.success, true);
  assert.equal(result.response, 'ok');
});

test('opencode surfaces an error event and exit code as a failure that is not a quota hit', async () => {
  const stdout = JSON.stringify({type: 'error', error: {type: 'provider.no-route', message: 'Model unavailable: opencode/nope'}});
  const result = await opencodeAdapter(command).parseResult(raw(stdout, {exitCode: 1}));
  assert.equal(result.success, false);
  assert.equal(result.error, 'Model unavailable: opencode/nope');
  assert.equal(result.isQuotaExceeded, false);
});

test('opencode reports a quota failure so the pool can fail over', async () => {
  const stdout = JSON.stringify({type: 'error', error: {message: '429 Too many requests'}});
  const result = await opencodeAdapter(command).parseResult(raw(stdout, {exitCode: 1}));
  assert.equal(result.success, false);
  assert.equal(result.isQuotaExceeded, true);
  assert.equal(result.cliStatus, 'quota_exceeded');
  assert.match(result.error ?? '', /429/);
});

test('opencode does not treat an answer that mentions a rate limit as a quota failure', async () => {
  const result = await opencodeAdapter(command).parseResult(raw([text('Added a retry for 429 Too many requests responses.'), finish('stop')].join('\n')));
  assert.equal(result.success, true);
  assert.notEqual(result.isQuotaExceeded, true);
});

test('opencode fails clearly on an empty answer, an error event with exit 0, and a signal', async () => {
  const empty = await opencodeAdapter(command).parseResult(raw(''));
  assert.equal(empty.success, false);
  assert.equal(empty.error, 'OpenCode did not provide a final message');
  const errored = await opencodeAdapter(command).parseResult(raw([text('partial'), JSON.stringify({type: 'error', error: {message: 'boom'}})].join('\n')));
  assert.equal(errored.success, false);
  assert.equal(errored.error, 'boom');
  const killed = await opencodeAdapter(command).parseResult(raw('', {exitCode: null, signal: 'SIGTERM'}));
  assert.equal(killed.success, false);
  assert.match(killed.error ?? '', /terminated \(SIGTERM\)/);
});

test('opencode falls back to the stderr tail, then the exit code, when nothing else explains a failure', async () => {
  const withStderr = await opencodeAdapter(command).parseResult(raw('', {exitCode: 2, stderr: 'noise\nbad config\n'}));
  assert.equal(withStderr.error, 'bad config');
  const bare = await opencodeAdapter(command).parseResult(raw('', {exitCode: 3}));
  assert.equal(bare.error, 'OpenCode exited 3');
});

test('only the owner config turns on --auto, and agents_list says so', async () => {
  const config: Config = {
    allowed_workspaces: [], executable: 'agy', max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144,
    max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport: 'argv',
    agents: {enabled: ['opencode', 'oc-work'], opencode_executable: 'no-such-opencode-cli', opencode_auto_approve: true,
      profiles: {'oc-work': {adapter: 'opencode'}}}
  };
  const registry = await createAgentRegistry(config, {executable: 'agy', supported: true, version: '1.4.7', warnings: []});
  for (const id of ['opencode', 'oc-work']) {
    const agent = registry.agents.find(item => item.adapter.id === id)!;
    assert.ok(agent.status.warnings.some(warning => /auto-approve permissions/.test(warning) && warning.includes(`"${id}"`)), `${id} reports --auto in its warnings`);
    assert.ok(agent.adapter.buildInvocation(task({autonomy: 'suggest'})).args.includes('--auto'), `${id} runs with --auto`);
  }
  const off = await createAgentRegistry({...config, agents: {...config.agents, opencode_auto_approve: undefined}}, {executable: 'agy', supported: true, version: '1.4.7', warnings: []});
  for (const agent of off.agents.filter(item => item.adapter.family === 'opencode')) {
    assert.ok(!agent.adapter.buildInvocation(task({autonomy: 'full'})).args.includes('--auto'));
    assert.ok(!agent.status.warnings.some(warning => /auto-approve/.test(warning)));
  }
});

test('an opencode profile declared without agents.enabled is probed and says why it is unavailable', async () => {
  const base: Config = {
    allowed_workspaces: [], executable: 'agy', max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144,
    max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const inspection = {executable: 'agy', supported: true, version: '1.4.7', warnings: []};
  // `enabled` omitted: every profile is enabled, OpenCode itself is not. The profile must still reach the CLI check and report its result.
  const registry = await createAgentRegistry({...base, agents: {opencode_executable: 'no-such-opencode-cli', profiles: {'oc-work': {adapter: 'opencode'}}}}, inspection);
  const profile = registry.agents.find(item => item.adapter.id === 'oc-work')!;
  assert.equal(profile.status.available, false);
  assert.ok(profile.status.warnings.some(warning => /OpenCode CLI not found/.test(warning)), `the profile explains itself: ${JSON.stringify(profile.status.warnings)}`);
  assert.equal(profile.status.label, 'OpenCode (oc-work)', 'the default label names OpenCode, not Antigravity');
  // The base agent stays opt-in and says so, whatever the profile needed.
  const baseAgent = registry.agents.find(item => item.adapter.id === 'opencode')!;
  assert.equal(baseAgent.status.available, false);
  assert.deepEqual(baseAgent.status.warnings, ['Disabled in the bridge config']);
  // A profile with its own executable does not inherit the base binary's failure.
  const own = await createAgentRegistry({...base, agents: {opencode_executable: 'no-such-opencode-cli', profiles: {'oc-own': {adapter: 'opencode', executable: 'no-such-profile-cli'}}}}, inspection);
  const ownWarnings = own.agents.find(item => item.adapter.id === 'oc-own')!.status.warnings;
  assert.equal(ownWarnings.length, 1);
  assert.match(ownWarnings[0], /OpenCode CLI not found/);
});

test('a codex model in the config never becomes the model of another family\'s task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-oc-model-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const launched: string[][] = [];
  const agent: AgentRuntime = {
    adapter: opencodeAdapter(command, {id: 'opencode', model: 'opencode/own-model'}),
    status: {id: 'opencode', label: 'OpenCode', available: true, version: '2.2.5', executable: 'opencode', capabilities: ['code'], warnings: []},
    enabled: true,
    launch: args => {
      launched.push(args);
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 910_001; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      setTimeout(() => { child.stdout.end(`${[text('done'), finish('stop')].join('\n')}\n`); child.emit('close', 0, null); }, 10);
      return child as unknown as ChildProcess;
    }
  };
  const config = {allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 0, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv',
    agents: {codex_model: 'gpt-5'}} as unknown as Config;
  const manager = new TaskManager(config, {executable: 'opencode', supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'opencode'});
  try {
    const started = await manager.delegate({task: 'do the work', workspace, acceptance_criteria: ['done'], agent: 'opencode'});
    assert.equal((await manager.wait(started.task_id)).status, 'completed');
    const args = launched[0];
    assert.equal(args[args.indexOf('--model') + 1], 'opencode/own-model', 'OpenCode runs the model its own config names');
    assert.ok(!args.includes('gpt-5'));
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});

test('opencode is opt-in: the registry does not probe or enable it unless agents.enabled lists it', async () => {
  const config: Config = {
    allowed_workspaces: [], executable: 'agy', max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144,
    max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport: 'argv', agents: {}
  };
  const registry = await createAgentRegistry(config, {executable: 'agy', supported: true, version: '1.4.7', warnings: []});
  const opencode = registry.agents.find(agent => agent.adapter.id === 'opencode');
  assert.equal(opencode?.status.available, false);
  assert.deepEqual(opencode?.status.warnings, ['Disabled in the bridge config']);
  assert.notEqual(registry.defaultAgent, 'opencode');
});
