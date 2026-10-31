import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeAdapter } from '../src/agents/opencode.js';
import { createAgentRegistry } from '../src/agents/registry.js';
import type { Config } from '../src/config.js';
import type { AgentTask, RawRun } from '../src/agents/types.js';

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
  assert.deepEqual(invocation.args, ['run', '--format', 'json', '--model', 'opencode/big-pickle']);
  assert.equal(invocation.stdin, 'fix the bug\n- keep the second line\n');
  assert.equal(invocation.transport, undefined);
});

test('opencode invocation prefers the task model, and only full autonomy or the owner option adds --auto', () => {
  assert.deepEqual(opencodeAdapter(command, {model: 'a/b'}).buildInvocation(task({model: 'c/d'})).args.slice(-2), ['--model', 'c/d']);
  assert.ok(!opencodeAdapter(command).buildInvocation(task({autonomy: 'suggest'})).args.includes('--auto'));
  assert.ok(!opencodeAdapter(command).buildInvocation(task({autonomy: 'auto'})).args.includes('--auto'));
  assert.ok(opencodeAdapter(command).buildInvocation(task({autonomy: 'full'})).args.includes('--auto'));
  assert.ok(opencodeAdapter(command, {autoApprove: true}).buildInvocation(task()).args.includes('--auto'));
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
