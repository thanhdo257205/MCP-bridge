import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeElevation, elevationOptions, elevationRefusal, isPendingApproval, parseElevation } from '../src/approvals.js';
import { codexAdapter } from '../src/agents/codex.js';
import { opencodeAdapter } from '../src/agents/opencode.js';
import type { AgentTask, DeniedAction, RawRun } from '../src/agents/types.js';

const command = {executable: 'cli', prefixArgs: [], source: 'cli'};
const task = (extra: Partial<AgentTask> = {}): AgentTask => ({
  prompt: 'do the work', workspace: path.join(tmpdir(), 'ws'), timeoutSeconds: 60, autonomy: 'auto', owns: [], taskId: 't1', stateDirectory: tmpdir(), ...extra
});
const raw = (stdout: string, extra: Partial<RawRun> = {}): RawRun => ({stdout, stderr: '', exitCode: 0, signal: null, resultFile: null, ...extra});
const denial = (action: string, display = action): DeniedAction => ({action, display_name: display});

test('the options offered depend on the agent, start with the narrowest, and are empty when nothing was refused', () => {
  assert.deepEqual(elevationOptions('antigravity', []), []);
  const agy = elevationOptions('antigravity', [denial('write_file')]);
  assert.deepEqual(agy.map(option => option.elevation), [{kind: 'agy-level', level: 'accept-edits'}, {kind: 'agy-level', level: 'auto'}, {kind: 'agy-level', level: 'full'}]);
  assert.deepEqual(agy.map(option => option.narrowest), [true, false, false]);
  assert.deepEqual(agy.map(option => option.wide), [false, false, true], 'only skipping every permission is marked wide');

  const codex = elevationOptions('codex', [denial('command', 'powershell Set-Content')]);
  assert.equal(codex.length, 1);
  assert.equal(codex[0].kind, 'codex-add-dir');
  assert.equal(codex[0].needs_dir, true, 'the directory is typed by the owner, never guessed');
  assert.equal(codex[0].elevation, null);

  const opencode = elevationOptions('opencode', [denial('shell', 'shell: echo hi'), denial('write', 'write: a.txt')]);
  assert.deepEqual(opencode.map(option => option.elevation), [{kind: 'opencode-allow', permission: 'bash'}, {kind: 'opencode-allow', permission: 'edit'}, {kind: 'opencode-auto'}]);
  assert.deepEqual(opencode.map(option => option.wide), [false, false, true]);
  assert.deepEqual(elevationOptions('opencode', [denial('webfetch')]).map(option => option.kind), ['opencode-auto'], 'a tool with no narrow permission only offers the wide one');
});

test('an elevation is parsed strictly: unknown kinds, levels and extra fields are refused', () => {
  assert.deepEqual(parseElevation({kind: 'agy-level', level: 'accept-edits'}), {kind: 'agy-level', level: 'accept-edits'});
  assert.deepEqual(parseElevation({kind: 'opencode-auto'}), {kind: 'opencode-auto'});
  for (const bad of [null, 'full', {}, {kind: 'agy-level', level: 'plan'}, {kind: 'agy-level', level: 'full', extra: 1}, {kind: 'opencode-auto', dir: 'x'},
    {kind: 'opencode-allow', permission: 'webfetch'}, {kind: 'codex-add-dir'}, {kind: 'codex-add-dir', dir: ''}, {kind: 'codex-full-access'}]) {
    assert.throws(() => parseElevation(bad), /not one of the permissions/, JSON.stringify(bad));
  }
});

test('an elevation is only given to the agent it belongs to, for what the task was refused, and never for a directory that is a root', () => {
  const shellDenied = [denial('shell')];
  assert.equal(elevationRefusal('opencode', shellDenied, {kind: 'opencode-allow', permission: 'bash'}), null);
  assert.match(elevationRefusal('opencode', shellDenied, {kind: 'opencode-allow', permission: 'edit'}) ?? '', /was not refused "edit"/);
  assert.match(elevationRefusal('antigravity', [denial('write_file')], {kind: 'codex-add-dir', dir: tmpdir()}) ?? '', /cannot be given/);
  assert.match(elevationRefusal('codex', [denial('command')], {kind: 'agy-level', level: 'full'}) ?? '', /cannot be given/);
  assert.equal(elevationRefusal('codex', [denial('command')], {kind: 'codex-add-dir', dir: tmpdir()}), null);
  assert.match(elevationRefusal('codex', [denial('command')], {kind: 'codex-add-dir', dir: 'relative/dir'}) ?? '', /absolute/);
  assert.match(elevationRefusal('codex', [denial('command')], {kind: 'codex-add-dir', dir: path.parse(tmpdir()).root}) ?? '', /root/);
  assert.match(elevationRefusal('antigravity', [], {kind: 'agy-level', level: 'auto'}) ?? '', /cannot be given/, 'a task that was refused nothing has nothing to approve');
  assert.equal(describeElevation({kind: 'agy-level', level: 'full'}), 'antigravity --dangerously-skip-permissions');
});

test('a task waits for approval only when it ended, was refused something, and was not settled', () => {
  const base = {task_id: 'a', status: 'failed', denied_actions: [denial('x')]};
  assert.equal(isPendingApproval(base), true);
  assert.equal(isPendingApproval({...base, status: 'completed'}), true, 'a completed task that was refused something is still queued');
  assert.equal(isPendingApproval({...base, status: 'running'}), false);
  assert.equal(isPendingApproval({...base, status: 'queued'}), false);
  assert.equal(isPendingApproval({...base, denied_actions: []}), false);
  assert.equal(isPendingApproval({...base, approval: {state: 'rerun'}}), false);
  assert.equal(isPendingApproval({...base, approval: {state: 'dismissed'}}), false);
});

const event = (type: string, part: Record<string, unknown>) => JSON.stringify({type, part});
const refusedShell = (input: unknown = {command: 'echo IN_OK > inside.txt'}) => event('tool_use', {tool: 'shell', state: {
  status: 'error', input, error: 'This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.'
}});
const finish = event('step_finish', {reason: 'stop', tokens: {input: 1, output: 1}});

test('opencode reports a permission it auto-rejected, from the full stream and from the compacted one, and keeps the run successful', async () => {
  const adapter = opencodeAdapter(command);
  const stream = [event('step_start', {}), refusedShell(), event('text', {text: 'It was rejected.'}), finish];
  const full = await adapter.parseResult(raw(stream.join('\n')));
  assert.deepEqual(full.deniedActions, [{action: 'shell', display_name: 'shell: echo IN_OK > inside.txt'}]);
  assert.equal(full.success, true, 'a refused tool call does not by itself fail the run');
  const compacted = stream.map(line => adapter.compactLine!(line)).filter((line): line is string => line !== null).join('\n');
  assert.deepEqual((await adapter.parseResult(raw(compacted))).deniedActions, full.deniedActions, 'the log kept for the task still carries the refusal');

  const twice = await adapter.parseResult(raw([refusedShell(), refusedShell(), event('text', {text: 'x'}), finish].join('\n')));
  assert.equal(twice.deniedActions.length, 1, 'the same refusal repeated is listed once');
  const other = await adapter.parseResult(raw([event('tool_use', {tool: 'read', state: {status: 'error', input: {path: 'nope'}, error: 'File not found: nope'}}), event('text', {text: 'x'}), finish].join('\n')));
  assert.deepEqual(other.deniedActions, [], 'a tool that failed for any other reason is not a refused permission');
});

test('opencode applies a granted permission to one run only, through its environment and arguments', () => {
  const plain = opencodeAdapter(command).buildInvocation(task());
  assert.equal(plain.customEnv, undefined);
  assert.ok(!plain.args.includes('--auto'));

  const allowBash = opencodeAdapter(command).buildInvocation(task({elevation: {kind: 'opencode-allow', permission: 'bash'}}));
  assert.deepEqual(JSON.parse(allowBash.customEnv!.OPENCODE_CONFIG_CONTENT), {permission: {bash: 'allow'}});
  assert.ok(!allowBash.args.includes('--auto'), 'the narrow grant does not take every approval away');

  // What the profile already set survives; only the one permission changes.
  const merged = opencodeAdapter(command, {env: {XDG_DATA_HOME: 'D:\\d', OPENCODE_CONFIG_CONTENT: JSON.stringify({model: 'a/b', permission: {edit: 'ask', bash: 'ask'}})}})
    .buildInvocation(task({elevation: {kind: 'opencode-allow', permission: 'bash'}}));
  assert.equal(merged.customEnv!.XDG_DATA_HOME, 'D:\\d');
  assert.deepEqual(JSON.parse(merged.customEnv!.OPENCODE_CONFIG_CONTENT), {model: 'a/b', permission: {edit: 'ask', bash: 'allow'}});

  assert.throws(() => opencodeAdapter(command, {env: {OPENCODE_CONFIG_CONTENT: '{nope'}}).buildInvocation(task({elevation: {kind: 'opencode-allow', permission: 'bash'}})), /Cannot widen/);
  assert.throws(() => opencodeAdapter(command, {env: {OPENCODE_CONFIG_CONTENT: JSON.stringify({permission: 'ask'})}}).buildInvocation(task({elevation: {kind: 'opencode-allow', permission: 'bash'}})), /Cannot widen/,
    'one string for every permission cannot be opened for a single one without loosening the rest');

  assert.ok(opencodeAdapter(command).buildInvocation(task({elevation: {kind: 'opencode-auto'}})).args.includes('--auto'));
  assert.ok(!opencodeAdapter(command).buildInvocation(task({elevation: {kind: 'codex-add-dir', dir: tmpdir()}})).args.includes('--add-dir'), 'a grant for another agent has no effect here');
});

const commandItem = (status: string, output: string, exit = 1) => JSON.stringify({type: 'item.completed', item: {type: 'command_execution', command: 'powershell -Command "Set-Content out.txt x"', status, exit_code: exit, aggregated_output: output}});
const message = JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'The write was refused.'}});

test('codex marks a command the sandbox refused as suspected, without failing the task, and still fails on a reported denial', async () => {
  const adapter = codexAdapter(command);
  // The output measured on codex-cli 0.163.0: the sandbox refuses by failing the command, with no approval event.
  const refused = commandItem('failed', "Set-Content : Access to the path 'C:\\Users\\u\\out.txt' is denied.");
  const result = await adapter.parseResult(raw([refused, message].join('\n')));
  assert.equal(result.success, true, 'the agent finished and said what happened; the task is not failed on a guess');
  assert.deepEqual(result.deniedActions.map(item => item.suspected), [true]);
  assert.equal(result.deniedActions[0].action, 'command');

  const ordinary = await adapter.parseResult(raw([commandItem('failed', 'SyntaxError: unexpected token'), message].join('\n')));
  assert.deepEqual(ordinary.deniedActions, [], 'a command that failed for another reason is not suspected');
  const succeeded = await adapter.parseResult(raw([commandItem('completed', 'Permission denied was printed by the test itself', 0), message].join('\n')));
  assert.deepEqual(succeeded.deniedActions, [], 'only a failed command counts');

  const declined = await adapter.parseResult(raw([JSON.stringify({type: 'item.completed', item: {type: 'command_execution', status: 'declined', command: 'rm -rf build'}}), message].join('\n')));
  assert.equal(declined.success, false, 'a denial the CLI itself reported still fails the task');
  assert.equal(declined.deniedActions[0].suspected, undefined);
});

test('codex opens exactly the directory the owner granted for one run, ahead of the prompt marker', () => {
  const dir = path.join(tmpdir(), 'granted');
  const granted = codexAdapter(command).buildInvocation(task({elevation: {kind: 'codex-add-dir', dir}})).args;
  assert.equal(granted[granted.indexOf('--add-dir') + 1], dir);
  assert.equal(granted.at(-1), '-', 'the prompt marker stays last');
  assert.equal(granted.filter(arg => arg === '--add-dir').length, 1);
  assert.ok(!codexAdapter(command).buildInvocation(task()).args.includes('--add-dir'));
  assert.ok(!codexAdapter(command).buildInvocation(task({elevation: {kind: 'opencode-auto'}})).args.includes('--add-dir'), 'a grant for another agent has no effect here');
});
