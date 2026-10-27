import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { assertPlan, MAX_RETAINED_MISSIONS, MissionManager, missionCreateSchema, type TaskRunner } from '../src/missions/missions.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { startHttpBridge } from '../src/http.js';
import type { Config } from '../src/config.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs', import.meta.url));
type CreateInput = Parameters<MissionManager['create']>[0];
type StepInput = CreateInput['steps'][number];

async function harness(scenario = 'ok', overrides: Partial<Config> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-mission-'));
  const workspace = path.join(root, 'work'); await mkdir(workspace);
  const config: Config = {allowed_workspaces:[workspace], executable:process.execPath, max_timeout_seconds:30, default_timeout_seconds:20,
    max_output_bytes:4096, max_retained_tasks:10, max_queued_tasks:0, extra_env_passthrough:[], prompt_transport:'argv', ...overrides};
  // The fake CLI picks its behaviour from the prompt, so one plan can hold a step that succeeds and a step that fails.
  const runtime = {executable:process.execPath, supported:true, stateDirectory:path.join(root,'state'),
    launch:(args:string[], cwd:string) => startProcess(process.execPath, [fixture, JSON.stringify(args).includes('boom') ? 'fail' : scenario], cwd)};
  const manager = new TaskManager(config, runtime);
  return {root, workspace, config, runtime, manager, missions:new MissionManager(manager, config)};
}

const step = (workspace: string, id: string, depends_on: string[] = [], extra: Record<string, unknown> = {}): StepInput =>
  ({step_id: id, title: `Bước ${id}`, depends_on, delegate: {task: `make ${id}`, workspace, acceptance_criteria: [`${id} verified`], ...extra}}) as StepInput;
const plan = (workspace: string, ids: [string, string[]][]): CreateInput =>
  ({title: 'Ship the thing', goal: 'prove the plan store', workspace, steps: ids.map(([id, depends_on]) => step(workspace, id, depends_on))}) as CreateInput;

test('plan rules reject a graph that could never be dispatched correctly', () => {
  const good = {step_id: 'a', depends_on: [] as string[], delegate: {workspace: '/w', timeout_seconds: 5}};
  const at = (over: Record<string, unknown>) => [{...good, ...over}];
  assert.throws(() => assertPlan(at({step_id: 'a'}), [good], '/w', 30), /append-only/);
  assert.throws(() => assertPlan(at({step_id: 'b', depends_on: ['nope']}), [good], '/w', 30), /not in the plan/);
  assert.throws(() => assertPlan(at({step_id: 'b', depends_on: ['b']}), [good], '/w', 30), /depends on itself/);
  assert.throws(() => assertPlan(at({step_id: 'b', depends_on: ['a', 'a']}), [good], '/w', 30), /same dependency twice/);
  assert.throws(() => assertPlan(at({step_id: 'b', delegate: {workspace: '/other'}}), [good], '/w', 30), /runs entirely in/);
  assert.throws(() => assertPlan(at({step_id: 'b', delegate: {workspace: '/w', timeout_seconds: 31}}), [good], '/w', 30), /bridge limit is 30s/);
  // Appending "b" that waits for "c" closes the loop c -> b -> c: only a search over existing plus new steps sees it.
  assert.throws(() => assertPlan(at({step_id: 'b', depends_on: ['c']}), [{...good, step_id: 'c', depends_on: ['b']}], '/w', 30), /dependency cycle: c -> b -> c/);
  assert.equal(assertPlan(at({step_id: 'b'}), [good], '/w', 30), undefined);
});

test('plan schema bounds steps, ids and unknown fields', () => {
  const workspace = '/w';
  const withSteps = (steps: unknown[]) => ({...plan(workspace, []), steps});
  assert.equal(missionCreateSchema.safeParse(withSteps(Array.from({length: 13}, (_, i) => step(workspace, `s${i}`)))).success, false, 'a mission holds at most 12 steps');
  for (const bad of ['A-one', '-a', 'a b', 'a'.repeat(65), 'a/b', '']) {
    assert.equal(missionCreateSchema.safeParse(withSteps([step(workspace, bad)])).success, false, `${JSON.stringify(bad)} is not a step_id`);
  }
  assert.equal(missionCreateSchema.safeParse({...withSteps([step(workspace, 'a')]), owner: 'me'}).success, false);
  assert.equal(missionCreateSchema.safeParse(withSteps([{...step(workspace, 'a'), retry: true}])).success, false);
  assert.equal(missionCreateSchema.safeParse(withSteps([])).success, false, 'an empty plan is not a plan');
  assert.equal(missionCreateSchema.safeParse(plan(workspace, [['a', []], ['b', ['a']]])).success, true);
});

test('create canonicalizes an allowed workspace and refuses one outside the allowlist', async () => {
  const {missions, manager, workspace, root} = await harness();
  const created = await missions.create(plan(workspace, [['a', []]]), {client: 'Tech Lead'});
  assert.equal(created.workspace, await realpath(workspace));
  assert.equal(created.client, 'Tech Lead');
  const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
  await assert.rejects(() => missions.create(plan(elsewhere, [['a', []]])), /outside the allowlist/);
  assert.equal(manager.list().length, 0, 'a refused plan starts nothing');
});

test('the single-workspace rule gates on the directory, not on how the client spelled it', async () => {
  // CI found this: the Windows runner's temp dir is a short path (C:\Users\RUNNER~1\…), so the plan stored the
  // canonicalized workspace while the client kept sending its own spelling — and extend refused the very directory
  // the mission was already running in. A trailing separator reproduces the same split on any OS.
  const {missions, manager, workspace, root} = await harness();
  const alias = workspace + path.sep;
  const created = await missions.create(plan(alias, [['a', []]]));
  assert.equal(created.workspace, await realpath(workspace), 'the record keeps the canonical directory');
  assert.deepEqual([...new Set(created.steps.map(entry => entry.delegate.workspace))], [created.workspace],
    'a plan must not print two spellings of one workspace in mission_plan');
  await missions.extend(created.mission_id, [step(alias, 'b', ['a'])]);
  const first = await missions.dispatch(created.mission_id, 'a');
  await manager.wait(first.task.task_id);
  const started = await missions.dispatch(created.mission_id, 'b');
  assert.equal(started.task.workspace, created.workspace, 'both the recorded and the appended step run in the canonical directory');
  await manager.wait(started.task.task_id);
  // A different directory is still refused, and refused as a plan problem rather than as an unreadable path.
  const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere);
  await assert.rejects(() => missions.extend(created.mission_id, [step(elsewhere, 'c', ['a'])]), /runs entirely in/);
  await assert.rejects(() => missions.extend(created.mission_id, [step(path.join(elsewhere, 'nope'), 'd', ['a'])]), /runs entirely in/);
  assert.equal(missions.view(created.mission_id).progress.total, 2, 'a refused append adds nothing to the plan');
});

test('a step starts only after every dependency its plan names has completed', async () => {
  const {missions, manager, workspace} = await harness();
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', ['a']], ['c', ['b']]]));
  await assert.rejects(() => missions.dispatch(mission_id, 'b'), /step "b" is not ready: "a" is ready/);
  await assert.rejects(() => missions.dispatch(mission_id, 'c'), /"b" is pending/);
  await assert.rejects(() => missions.dispatch(mission_id, 'missing'), /has no step "missing"/);
  const first = await missions.dispatch(mission_id, 'a');
  await manager.wait(first.task.task_id);
  assert.deepEqual(missions.view(mission_id).ready, ['b']);
  const second = await missions.dispatch(mission_id, 'b');
  await manager.wait(second.task.task_id);
  assert.deepEqual(missions.view(mission_id).progress, {total: 3, completed: 2, active: 0, ready: 1, pending: 0, unmet: 0});
  const third = await missions.dispatch(mission_id, 'c');
  await manager.wait(third.task.task_id);
  assert.deepEqual(missions.view(mission_id).progress, {total: 3, completed: 3, active: 0, ready: 0, pending: 0, unmet: 0});
});

test('a failed dependency never unlocks the step waiting for it', async () => {
  const {missions, manager, workspace} = await harness();
  const {mission_id} = await missions.create({title: 't', goal: 'g', workspace,
    steps: [step(workspace, 'a', [], {task: 'make boom'}), step(workspace, 'b', ['a'])]} as CreateInput);
  const failed = await missions.dispatch(mission_id, 'a');
  await manager.wait(failed.task.task_id);
  const view = missions.view(mission_id);
  assert.equal(view.steps[0].state, 'failed');
  assert.equal(view.steps[1].state, 'pending');
  assert.deepEqual(view.steps[1].blocked_by, [{step_id: 'a', state: 'failed'}]);
  assert.deepEqual(view.ready, []);
  assert.equal(view.progress.unmet, 1);
  await assert.rejects(() => missions.dispatch(mission_id, 'b'), /step "b" is not ready: "a" is failed/);
});

test('a dispatch starts the task with exactly the arguments the plan recorded', async () => {
  const {missions, manager, workspace} = await harness('delayed');
  const recorded = {task: 'do the recorded thing', workspace, acceptance_criteria: ['a verified'], context: 'recorded context', timeout_seconds: 12, isolation: 'none' as const};
  const {mission_id} = await missions.create({title: 't', goal: 'g', workspace, steps: [{step_id: 'a', title: 'A', depends_on: [], delegate: recorded}]} as unknown as CreateInput);
  const {task} = await missions.dispatch(mission_id, 'a');
  const request = manager.detail(task.task_id).request;
  assert.ok(request, 'the started task keeps the request it was planned with');
  assert.equal(request.task, recorded.task);
  assert.equal(request.context, recorded.context);
  assert.equal(request.timeout_seconds, 12);
  assert.deepEqual(request.acceptance_criteria, ['a verified']);
  assert.equal(request.client, `mission ${mission_id}/a`);
  await manager.wait(task.task_id);
  assert.equal(missions.view(mission_id).steps[0].task_id, task.task_id);
});

test('two concurrent dispatches of one step cannot both reach the runner', async () => {
  const {workspace, config, manager} = await harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Without the in-flight guard both calls wait behind this gate and each starts a task for the same step.
  const slow: TaskRunner = {delegate: async (raw, meta) => { await gate; return manager.delegate(raw, meta); },
    summary: id => manager.summary(id), cancel: id => manager.cancel(id), get stateDirectory() { return manager.stateDirectory; }};
  const missions = new MissionManager(slow, config);
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', []]]));
  const first = missions.dispatch(mission_id, 'a');
  await assert.rejects(() => missions.dispatch(mission_id, 'a'), /already being dispatched by another call/);
  release();
  const {task} = await first;
  await manager.wait(task.task_id);
  assert.equal(manager.list().length, 1, 'one step, one task');
  assert.equal(missions.view(mission_id).steps.find(s => s.step_id === 'a')?.task_id, task.task_id);
  await assert.rejects(() => missions.dispatch(mission_id, 'a'), /already bound to task/);
  const other = await missions.dispatch(mission_id, 'b');
  await manager.wait(other.task.task_id);
});

test('a dispatch the bridge refuses leaves the step unbound and retryable', async () => {
  const {missions, manager, workspace} = await harness('hang');
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', []]]));
  const blocking = await missions.dispatch(mission_id, 'a');
  try {
    await assert.rejects(() => missions.dispatch(mission_id, 'b'), /busy/);
    const refused = missions.view(mission_id).steps.find(s => s.step_id === 'b');
    assert.equal(refused?.task_id, null, 'a refused dispatch must not bind a task that never started');
    assert.equal(refused?.state, 'ready');
  } finally {
    await manager.cancel(blocking.task.task_id);
  }
  const retry = await missions.dispatch(mission_id, 'b');
  assert.equal(retry.task.status, 'running');
  await manager.cancel(retry.task.task_id);
});

test('cancel closes the plan without touching a running agent, unless it is asked to', async () => {
  const {missions, manager, workspace} = await harness('hang');
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', ['a']]]));
  const running = await missions.dispatch(mission_id, 'a');
  try {
    const stopped = await missions.cancel(mission_id);
    assert.equal(stopped.mission.status, 'canceled');
    assert.deepEqual(stopped.running, [running.task.task_id]);
    assert.deepEqual(stopped.canceled, []);
    assert.equal(manager.get(running.task.task_id).status, 'running', 'stopping a plan is not stopping a process');
    assert.equal(missions.view(mission_id).status, 'canceled');
    await assert.rejects(() => missions.dispatch(mission_id, 'b'), /is canceled: no step can be dispatched/);
    await assert.rejects(() => missions.extend(mission_id, [step(workspace, 'z')]), /can no longer change/);
    const again = await missions.cancel(mission_id, {cancelRunningTasks: false});
    assert.deepEqual(again.canceled, [], 'canceling twice changes nothing more');
    const forced = await missions.cancel(mission_id, {cancelRunningTasks: true});
    assert.deepEqual(forced.canceled, [running.task.task_id]);
    assert.equal(manager.get(running.task.task_id).status, 'canceled');
  } finally {
    await manager.cancel(running.task.task_id).catch(() => undefined);
  }
});

test('the plan is append-only: a retry is a new step and the old one stays bound', async () => {
  const {missions, manager, workspace} = await harness();
  const {mission_id} = await missions.create(plan(workspace, [['a', []]]));
  const {task} = await missions.dispatch(mission_id, 'a');
  await manager.wait(task.task_id);
  await assert.rejects(() => missions.dispatch(mission_id, 'a'), /dispatch a new step to try again/);
  await assert.rejects(() => missions.extend(mission_id, [step(workspace, 'a')]), /already in the plan/);
  await missions.extend(mission_id, [step(workspace, 'a2', ['a']), step(workspace, 'w2', ['a'], {isolation: 'worktree', owns: ['src/a.ts']})]);
  const view = missions.view(mission_id);
  assert.deepEqual(view.ready, ['a2', 'w2']);
  assert.equal(view.steps[0].state, 'completed');
  assert.equal(view.steps[2].isolation, 'worktree');
  const retry = await missions.dispatch(mission_id, 'a2');
  assert.notEqual(retry.task.task_id, task.task_id);
  await manager.wait(retry.task.task_id);
  assert.equal(missions.view(mission_id).progress.completed, 2);
});

test('a task record retention dropped shows its step as lost, not as completed', async () => {
  const {missions, manager, workspace} = await harness('ok', {max_retained_tasks: 1});
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', ['a']]]));
  const first = await missions.dispatch(mission_id, 'a');
  await manager.wait(first.task.task_id);
  assert.equal(missions.view(mission_id).steps[0].state, 'completed');
  // Any later finished task evicts the only record, so the plan loses the proof that "a" ever ended well.
  const filler = await manager.delegate({task: 'filler', workspace, acceptance_criteria: ['x']});
  await manager.wait(filler.task_id);
  const view = missions.view(mission_id);
  assert.equal(view.steps[0].state, 'lost');
  assert.equal(view.steps[1].state, 'pending');
  assert.deepEqual(view.steps[1].blocked_by, [{step_id: 'a', state: 'lost'}]);
  await assert.rejects(() => missions.dispatch(mission_id, 'b'), /"a" is lost/);
});

test('retention drops the oldest plan with nothing in flight and keeps one that is running', async () => {
  const {missions, manager, workspace} = await harness('hang');
  const busy = await missions.create(plan(workspace, [['a', []]]));
  const running = await missions.dispatch(busy.mission_id, 'a');
  const quiet: string[] = [];
  try {
    for (let i = 0; i < MAX_RETAINED_MISSIONS; i++) quiet.push((await missions.create(plan(workspace, [['a', []]]))).mission_id);
    assert.equal(missions.list().some(m => m.mission_id === busy.mission_id), true, 'a plan with a running task is never dropped');
    assert.equal(missions.list().some(m => m.mission_id === quiet[0]), false, 'the oldest plan with nothing in flight makes room');
    assert.equal(missions.list().length, MAX_RETAINED_MISSIONS);
    const onDisk = await readdir(path.join(manager.stateDirectory, 'missions'));
    assert.equal(onDisk.includes(`${quiet[0]}.json`), false, 'an evicted plan is removed from disk too');
    assert.equal(onDisk.includes(`${busy.mission_id}.json`), true);
  } finally {
    await manager.cancel(running.task.task_id);
  }
});

test('a restart restores plans with task-derived states and dispatches nothing by itself', async () => {
  const {workspace, config, runtime, manager, missions} = await harness();
  const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', ['a']]]));
  const {task} = await missions.dispatch(mission_id, 'a');
  await manager.wait(task.task_id);
  const directory = path.join(manager.stateDirectory, 'missions');
  assert.deepEqual(await readdir(directory), [`${mission_id}.json`]);
  const record = JSON.parse(await readFile(path.join(directory, `${mission_id}.json`), 'utf8')) as {mission: {steps: {step_id: string; task_id: string | null; delegate: {task: string}}[]}};
  assert.deepEqual(record.mission.steps.map(s => [s.step_id, s.task_id !== null]), [['a', true], ['b', false]]);

  // A restart is a new manager over the same state directory, recovering the task records before the plans that name them.
  const restartedManager = new TaskManager(config, runtime);
  await restartedManager.restore();
  const restarted = new MissionManager(restartedManager, config);
  assert.equal(await restarted.restore(), 1);
  const view = restarted.view(mission_id);
  assert.equal(view.steps[0].state, 'completed');
  assert.deepEqual(view.ready, ['b']);
  assert.equal(restartedManager.list().length, 1, 'restoring a plan starts no task');
  await assert.rejects(() => restarted.dispatch(mission_id, 'a'), /already bound to task/);
  const next = await restarted.dispatch(mission_id, 'b');
  await restartedManager.wait(next.task.task_id);
});

test('a mission record this project did not write is skipped, never loaded or deleted', async () => {
  const {missions, manager, workspace, config} = await harness();
  const {mission_id} = await missions.create(plan(workspace, [['a', []]]));
  const directory = path.join(manager.stateDirectory, 'missions');
  const stranger = '11111111-1111-4111-8111-111111111111';
  const inside = '22222222-2222-4222-8222-222222222222';
  await writeFile(path.join(directory, 'garbage.json'), 'not json at all');
  await writeFile(path.join(directory, '33333333-3333-4333-8333-333333333333.json'), '{"mission":{"title":"wrong shape"}}');
  // A complete-looking record whose file name does not match the id inside it is not this plan store's record.
  const renamed = JSON.parse(await readFile(path.join(directory, `${mission_id}.json`), 'utf8')) as {mission: {mission_id: string}};
  renamed.mission.mission_id = inside;
  await writeFile(path.join(directory, `${stranger}.json`), JSON.stringify(renamed));
  const fresh = new MissionManager(manager, config);
  assert.equal(await fresh.restore(), 1);
  assert.deepEqual(fresh.list().map(m => m.mission_id), [mission_id]);
  assert.deepEqual(await readdir(directory), [
    `${mission_id}.json`, `${stranger}.json`, '33333333-3333-4333-8333-333333333333.json', 'garbage.json'].sort());
  assert.throws(() => fresh.view(stranger), /Unknown or expired mission_id/);
  assert.throws(() => fresh.view(inside), /Unknown or expired mission_id/, 'a renamed record is not loaded under the id written inside it');
});

test('secret-shaped text is redacted before a plan reaches disk', async () => {
  const {missions, manager, workspace} = await harness();
  const secrets = ['hunter2', 'abc.def.ghi', 'sesame123'];
  const {mission_id} = await missions.create({title: 'Bearer abc.def.ghi', goal: 'api_key=hunter2', workspace,
    steps: [{step_id: 'a', title: 'password=sesame123', depends_on: [],
      delegate: {task: 'paste api_key=hunter2 here', workspace, acceptance_criteria: ['Bearer abc.def.ghi'], context: 'password=sesame123'}}]} as unknown as CreateInput);
  const stored = JSON.stringify(JSON.parse(await readFile(path.join(manager.stateDirectory, 'missions', `${mission_id}.json`), 'utf8')));
  for (const secret of secrets) assert.ok(!stored.includes(secret), `${secret} reached disk`);
  const recorded = missions.planOf(mission_id);
  assert.match(recorded.title, /\[REDACTED\]/);
  assert.match(recorded.steps[0].delegate.task, /\[REDACTED\]/);
  assert.match(recorded.steps[0].delegate.acceptance_criteria[0], /\[REDACTED\]/);
  assert.match(recorded.steps[0].delegate.context as string, /\[REDACTED\]/);
  assert.match(recorded.goal, /\[REDACTED\]/);
});

test('MCP surface: receipts omit the plan, the gate reads as a tool error, a running step says wait', async () => {
  const {manager, missions, workspace} = await harness('delayed');
  const bridge = await startHttpBridge({manager, missions, environment: {cli_version: 'mock'}, port: 0});
  const client = new Client({name: 'mission-test', version: '1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['mission_create', 'mission_extend', 'mission_dispatch', 'mission_status', 'mission_plan', 'mission_cancel']) {
      assert.ok(names.includes(name), `${name} is missing`);
    }
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({name, arguments: args});
      if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
      return result.structuredContent as Record<string, any>;
    };
    const receipt = await call('mission_create', plan(workspace, [['a', []], ['b', ['a']]]));
    const mission_id = String(receipt.mission_id);
    assert.equal(JSON.stringify(receipt).includes('make a'), false, 'a receipt must not echo the plan back');
    assert.deepEqual(receipt.ready, ['a']);
    assert.deepEqual(receipt.progress, {total: 2, completed: 0, active: 0, ready: 1, pending: 1, unmet: 0});
    assert.match(String(receipt.next_step), /Dispatch a ready step/);
    await assert.rejects(() => call('mission_dispatch', {mission_id, step_id: 'b'}), /not ready/);
    const started = await call('mission_dispatch', {mission_id, step_id: 'a'});
    assert.deepEqual(Object.keys(started).sort(), ['duration_ms', 'mission_id', 'next_step', 'status', 'step_id', 'task_id'].sort());
    assert.equal(started.status, 'running');
    assert.match(String(started.next_step), /antigravity_task_wait/);
    const status = await call('mission_status', {mission_id});
    assert.deepEqual(status.ready, []);
    assert.equal(JSON.stringify(status).includes('make a'), false, 'mission_status stays cheap');
    const full = await call('mission_plan', {mission_id});
    assert.equal(full.steps[0].delegate.task, 'make a');
    assert.equal(full.workspace, receipt.workspace);
    assert.match(String(full.next_step), /running/);
    await manager.wait(String(started.task_id));
    assert.deepEqual((await call('mission_status', {mission_id})).ready, ['b']);
    const stopped = await call('mission_cancel', {mission_id});
    assert.equal(stopped.status, 'canceled');
    assert.deepEqual(stopped.running_tasks, []);
    const refused = await client.callTool({name: 'mission_dispatch', arguments: {mission_id, step_id: 'b'}});
    assert.equal(refused.isError, true, 'a canceled plan grants nothing');
    assert.match(JSON.stringify(refused.structuredContent), /is canceled: no step can be dispatched/);
    await assert.rejects(() => call('mission_status', {mission_id: '00000000-0000-4000-8000-000000000000'}), /Unknown or expired mission_id/);
    await assert.rejects(() => call('mission_create', {...plan(workspace, [['a', []]]), workspace: path.dirname(workspace)}), /runs entirely in/);
  } finally {
    await client.close(); await bridge.close();
  }
});

test('the UI reads a plan and its cancel closes the plan without stopping the agent it names', async () => {
  const {manager, missions, workspace} = await harness('hang');
  const bridge = await startHttpBridge({manager, missions, environment: {cli_version: 'mock'}, port: 0});
  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${bridge.baseUrl}/ui/api/${p}`, {...init, headers: {...(init.body ? {'Content-Type': 'application/json'} : {})}});
  let task_id = '';
  try {
    const {mission_id} = await missions.create(plan(workspace, [['a', []], ['b', ['a']]]));
    task_id = (await missions.dispatch(mission_id, 'a')).task.task_id;

    const list = await (await api('missions')).json() as {missions: {mission_id: string; ready: string[]; progress: {active: number}}[]; open: number; canceled: number; steps: number; ready: number};
    assert.deepEqual(list.missions.map(m => [m.mission_id, m.ready, m.progress.active]), [[mission_id, [], 1]]);
    assert.deepEqual([list.open, list.canceled, list.steps, list.ready], [1, 0, 2, 0]);
    assert.equal((await (await api('overview')).json() as {missions: {open: number}}).missions.open, 1);

    const planRoute = await api(`missions/${mission_id}`);
    assert.equal(planRoute.status, 200);
    const recorded = await planRoute.json() as {goal: string; steps: {step_id: string; state: string; delegate: {task: string}}[]};
    assert.equal(recorded.goal, 'prove the plan store');
    assert.deepEqual(recorded.steps.map(s => [s.step_id, s.state, s.delegate.task]), [['a', 'running', 'make a'], ['b', 'pending', 'make b']]);
    assert.equal((await api('missions/00000000-0000-4000-8000-000000000000')).status, 404, 'a plan that is not there is not a page');

    const unconfirmed = await api(`missions/${mission_id}/cancel`, {method: 'POST', body: JSON.stringify({})});
    assert.equal(unconfirmed.status, 400);
    assert.deepEqual(await unconfirmed.json(), {error: 'confirm must be true'});
    assert.equal(missions.view(mission_id).status, 'open', 'a cancel the page did not confirm changed nothing');

    const stopped = await (await api(`missions/${mission_id}/cancel`, {method: 'POST', body: JSON.stringify({confirm: true})})).json() as {status: string; running_tasks: string[]};
    assert.equal(stopped.status, 'canceled');
    assert.deepEqual(stopped.running_tasks, [task_id], 'the page has to show which agent it left running');
    assert.equal(manager.get(task_id).status, 'running', 'closing a plan from the page stops no process');
    assert.equal((await (await api('missions')).json()).open, 0);
  } finally {
    await manager.cancel(task_id).catch(() => undefined);
    await bridge.close();
  }
});
