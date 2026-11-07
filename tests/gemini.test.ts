import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiAdapter, lastJsonObject, GEMINI_UNVERIFIED_WARNING } from '../src/agents/gemini.js';
import { createAgentRegistry } from '../src/agents/registry.js';
import { elevationOptions } from '../src/approvals.js';
import type { Config } from '../src/config.js';
import type { AgentTask, RawRun } from '../src/agents/types.js';

const command = {executable: 'gemini', prefixArgs: [], source: 'gemini'};
const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  prompt: '-dash first\nsecond line', workspace: path.join(tmpdir(), 'ws'), timeoutSeconds: 60, autonomy: 'auto', owns: [], taskId: 't1', stateDirectory: tmpdir(), ...extra
});
const raw = (extra: Partial<RawRun>): RawRun => ({stdout: '', stderr: '', exitCode: 0, signal: null, resultFile: null, ...extra});
const fixture = (name: string) => readFile(fileURLToPath(new URL(`../../tests/fixtures/gemini/${name}`, import.meta.url)), 'utf8');
// The success shape is the CLI's JsonFormatter (0.67.0 bundle): {session_id, response, stats, error?, warnings?}, pretty-printed.
const success = (extra: Record<string, unknown> = {}) => JSON.stringify({
  session_id: '1bda1947-ce3b-46b1-9377-1f2deb90d8b6', response: 'Done: renamed the function.',
  stats: {models: {'gemini-3-pro': {api: {totalRequests: 3, totalErrors: 0, totalLatencyMs: 900}, tokens: {input: 10, prompt: 1200, candidates: 80, total: 1300, cached: 400, thoughts: 20, tool: 0}}},
    tools: {totalCalls: 2, totalSuccess: 2, totalFail: 0}, files: {totalLinesAdded: 3, totalLinesRemoved: 1}},
  ...extra
}, null, 2);

test('gemini invocation: headless with the prompt on stdin, owner approval mode, trusted for this run only, no MCP server', () => {
  const invocation = geminiAdapter(command).buildInvocation(task({autonomy: 'full', model: 'from-the-task'}));
  assert.deepEqual(invocation.args, ['-p', '', '--output-format', 'json', '--approval-mode', 'auto_edit', '--skip-trust', '--allowed-mcp-server-names', '__agy_bridge_no_mcp__']);
  assert.equal(invocation.stdin, '-dash first\nsecond line\n');
  const owned = geminiAdapter(command, {model: 'gemini-3-flash', approvalMode: 'plan', env: {GEMINI_CLI_HOME: '/acct2'}}).buildInvocation(task());
  assert.deepEqual(owned.args.slice(5, 7), ['plan', '--skip-trust']);
  assert.deepEqual(owned.args.slice(-2), ['--model', 'gemini-3-flash']);
  assert.deepEqual(owned.customEnv, {GEMINI_CLI_HOME: '/acct2'});
});

test('gemini: a pretty-printed success object gives the answer and the token usage summed over models', async () => {
  const parsed = await geminiAdapter(command).parseResult(raw({stdout: `${success()}\n`}));
  assert.equal(parsed.success, true);
  assert.equal(parsed.response, 'Done: renamed the function.');
  assert.equal(parsed.numTurns, 3);
  assert.deepEqual(parsed.stats?.usage, {input: 10, prompt: 1200, candidates: 80, total: 1300, cached: 400, thoughts: 20, tool: 0});
  assert.equal(parsed.conversationId, null, 'no resume is offered: --resume takes an index or "latest", not the session id');
});

test('gemini: the measured error outputs (0.67.0) become readable failures, not quota hits', async () => {
  const invalid = await geminiAdapter(command).parseResult(raw({stderr: await fixture('invalid-key.stderr.txt'), exitCode: 144}));
  assert.equal(invalid.success, false);
  assert.equal(invalid.error, 'INVALID_ARGUMENT (code 400): API key not valid. Please pass a valid API key.');
  assert.equal(invalid.isQuotaExceeded, false);
  const noAuth = await geminiAdapter(command).parseResult(raw({stderr: await fixture('no-auth.stderr.txt'), exitCode: 41}));
  assert.match(noAuth.error ?? '', /^Please set an Auth method/);
  assert.equal(noAuth.cliStatus, 'error 41');
  const limited = await geminiAdapter(command).parseResult(raw({stderr: JSON.stringify({error: {type: 'Error', code: 144,
    message: JSON.stringify({error: {message: JSON.stringify({error: {code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED'}}), code: 429}})}}, null, 2), exitCode: 144}));
  assert.equal(limited.isQuotaExceeded, true);
  assert.equal(limited.cliStatus, 'quota_exceeded');
});

test('gemini: a tool call denied by the policy engine fails the task and names the tool; nothing can widen it from the queue', async () => {
  const parsed = await geminiAdapter(command).parseResult(raw({stdout: success({response: 'I could not run the tests.'}),
    stderr: 'Tool execution for "Shell" denied by policy.\nTool execution for "Shell" denied by policy.\n'}));
  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.deniedActions, [{action: 'Shell', display_name: 'Shell: denied by policy'}]);
  assert.deepEqual(elevationOptions('gemini', parsed.deniedActions), []);
});

test('the last JSON object is found after plain warning lines, and nothing is invented from text that holds none', () => {
  assert.deepEqual(lastJsonObject('Warning: 256-color support not detected.\n{\n  "a": 1\n}\n'), {a: 1});
  assert.equal(lastJsonObject('no json here'), null);
  assert.equal(lastJsonObject(''), null);
});

test('Gemini CLI is opt-in, warns that it is unverified, and yolo is a visible warning', async () => {
  const base: Config = {allowed_workspaces: [], executable: 'agy', max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144,
    max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport: 'argv'};
  const inspection = {executable: 'agy', supported: true, version: '1.4.7', warnings: []};
  const off = (await createAgentRegistry(base, inspection)).agents.find(agent => agent.adapter.id === 'gemini')!;
  assert.equal(off.enabled, false);
  const on = await createAgentRegistry({...base, agents: {enabled: ['gemini'], gemini_executable: 'no-such-gemini-cli', gemini_approval_mode: 'yolo'}}, inspection);
  const gemini = on.agents.find(agent => agent.adapter.id === 'gemini')!;
  assert.equal(gemini.status.available, false);
  assert.ok(gemini.status.warnings.some(w => /Gemini CLI not found/.test(w)));
  assert.ok(on.warnings.some(w => /"gemini" is configured with dangerous permissions/.test(w)));
  assert.match(GEMINI_UNVERIFIED_WARNING, /no real task has been run/);
});
