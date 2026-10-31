import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { antigravityAdapter } from '../src/agents/antigravity.js';
import { codexAgent } from '../src/agents/codex.js';
import { opencodeAdapter } from '../src/agents/opencode.js';
import type { AgentRuntime, AgentStatus } from '../src/agents/types.js';
import { startProcess } from '../src/antigravity/process.js';
import type { Config } from '../src/config.js';
import { readDecisions } from '../src/decisions.js';
import { startHttpBridge } from '../src/http.js';
import { permissionState } from '../src/permissions.js';
import { TaskManager } from '../src/tasks/manager.js';
import { missionsFor } from './helpers.js';

const fixtureFile = (name: string) => fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));
const status = (id: string): AgentStatus => ({id, label: id, available: true, version: 'fake', executable: 'fixture', capabilities: ['code'], warnings: []});
interface Launch { args: string[]; env: Record<string, string> | undefined; }

/** A bridge whose agents are fakes that always report one refused action, and a record of exactly how each run was launched. */
async function setup(which: 'antigravity' | 'codex' | 'opencode', scenario = 'denied') {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-approvals-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const state = path.join(root, 'state');
  const launches: Launch[] = [];
  const record = (args: string[], options?: {customEnv?: Record<string, string>}) => launches.push({args, env: options?.customEnv});
  let agent: AgentRuntime;
  if (which === 'antigravity') {
    agent = {adapter: antigravityAdapter(process.execPath, 'argv'), status: status('antigravity'), enabled: true, prefixArgs: [],
      launch: (args, cwd, options) => { record(args, options); return startProcess(process.execPath, [fixtureFile('fake-agy.mjs'), scenario], cwd); }};
  } else if (which === 'codex') {
    const base = codexAgent({executable: process.execPath, prefixArgs: [], source: 'fixture'}, status('codex'));
    agent = {...base, launch: (args, cwd, options) => { record(args, options); return startProcess(process.execPath, [fixtureFile('fake-codex.mjs'), scenario, ...args], cwd, options); }};
  } else {
    agent = {adapter: opencodeAdapter({executable: process.execPath, prefixArgs: [], source: 'fixture'}), status: status('opencode'), enabled: true, prefixArgs: [],
      launch: (args, cwd, options) => { record(args, options); return startProcess(process.execPath, [fixtureFile('fake-opencode.mjs'), scenario], cwd, options); }};
  }
  const config: Config = {
    allowed_workspaces: [workspace], executable: process.execPath, max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 20, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: state, agents: [agent], defaultAgent: agent.adapter.id});
  const run = async () => {
    const started = await manager.delegate({task: 'create inside.txt', workspace, acceptance_criteria: ['file exists'], agent: agent.adapter.id});
    return manager.wait(started.task_id);
  };
  const finish = async () => { await manager.shutdown(); await rm(root, {recursive: true, force: true}); };
  return {root, workspace, state, manager, launches, run, finish, agent};
}

test('a refused task is queued, and approving it runs a NEW task with the chosen permission for that run only', async () => {
  const {state, manager, launches, run, finish} = await setup('antigravity');
  try {
    const first = await run();
    assert.equal(first.status, 'failed');
    assert.deepEqual(first.denied_actions, [{action: 'write_file', display_name: 'WriteFile'}]);
    const [queued] = manager.approvals();
    assert.equal(queued.task_id, first.task_id);
    assert.equal(queued.state, 'pending');
    assert.equal(queued.family, 'antigravity');
    assert.deepEqual(queued.options.map(option => option.elevation), [{kind: 'agy-level', level: 'accept-edits'}, {kind: 'agy-level', level: 'auto'}, {kind: 'agy-level', level: 'full'}]);
    assert.ok(!launches[0].args.includes('--mode'), 'the first run had the owner\'s own level');

    const approved = await manager.approveTask(first.task_id, {kind: 'agy-level', level: 'accept-edits'});
    assert.equal(approved.rerun_of, first.task_id);
    assert.notEqual(approved.task.task_id, first.task_id, 'a new task, not the old one started again');
    const second = await manager.wait(approved.task.task_id);
    assert.equal(second.retry_of, first.task_id);
    assert.deepEqual(second.elevation, {kind: 'agy-level', level: 'accept-edits'});
    const args = launches[1].args;
    assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits', 'the chosen level reached this run\'s command line');
    assert.equal(manager.detail(second.task_id).request?.permission, 'accept-edits');

    // The grant ends with the run: nothing in the owner's settings changed, and the next ordinary task starts from them again.
    assert.equal(permissionState(state).level, 'default');
    assert.equal(existsSync(path.join(state, 'permissions.json')), false);
    const third = await run();
    assert.ok(!launches[2].args.includes('--mode'), 'the next task is not elevated');
    assert.equal(third.elevation, undefined);
    assert.equal(third.retry_of, undefined);

    // The first task is settled; the rerun was refused too (the fake always is), so it waits for a NEW approval instead of inheriting this one.
    assert.deepEqual(manager.get(first.task_id).approval && {state: manager.get(first.task_id).approval!.state, task_id: manager.get(first.task_id).approval!.task_id}, {state: 'rerun', task_id: second.task_id});
    const states = Object.fromEntries(manager.approvals().map(view => [view.task_id, view.state]));
    assert.deepEqual(states, {[first.task_id]: 'rerun', [second.task_id]: 'pending', [third.task_id]: 'pending'});

    const log = (await readDecisions(state)).filter(item => item.task_id === first.task_id).map(item => [item.action, item.ok]).reverse();
    assert.deepEqual(log, [['approve', true], ['rerun', true]]);
  } finally { await finish(); }
});

test('an approval is refused, logged, and changes nothing when it asks for more than the agent can be given', async () => {
  const {state, manager, launches, run, finish} = await setup('antigravity');
  try {
    const first = await run();
    const wrong: unknown[] = [
      {kind: 'codex-add-dir', dir: tmpdir()}, {kind: 'opencode-auto'}, {kind: 'agy-level', level: 'plan'}, {kind: 'agy-level', level: 'full', extra: true}, null, 'full', {}
    ];
    for (const elevation of wrong) await assert.rejects(manager.approveTask(first.task_id, elevation), /cannot be given|not one of the permissions/, JSON.stringify(elevation));
    assert.equal(launches.length, 1, 'no run was started by a refused approval');
    assert.equal(manager.get(first.task_id).approval, undefined, 'the task still waits');
    const refusals = (await readDecisions(state)).filter(item => item.action === 'approve');
    assert.equal(refusals.length, wrong.length);
    assert.ok(refusals.every(item => !item.ok), 'every refusal is on the record');

    await assert.rejects(manager.approveTask('00000000-0000-4000-8000-000000000000', {kind: 'agy-level', level: 'auto'}), /Unknown or expired/);
  } finally { await finish(); }
});

test('a task that was refused nothing, or is still running, has nothing to approve', async () => {
  const clean = await setup('antigravity', 'ok');
  try {
    const done = await clean.run();
    assert.equal(done.status, 'completed');
    assert.deepEqual(clean.manager.approvals(), []);
    await assert.rejects(clean.manager.approveTask(done.task_id, {kind: 'agy-level', level: 'auto'}), /no refused actions/);
    await assert.rejects(clean.manager.dismissApproval(done.task_id), /no refused actions/);
  } finally { await clean.finish(); }

  const slow = await setup('antigravity', 'delayed');
  try {
    const started = await slow.manager.delegate({task: 'wait', workspace: slow.workspace, acceptance_criteria: ['x'], agent: 'antigravity'});
    await assert.rejects(slow.manager.approveTask(started.task_id, {kind: 'agy-level', level: 'auto'}), /still running|no refused actions/);
    await slow.manager.wait(started.task_id);
  } finally { await slow.finish(); }
});

test('two approvals of one task start one run, and an approved or dismissed task cannot be approved again', async () => {
  const {manager, launches, run, finish} = await setup('antigravity');
  try {
    const first = await run();
    const results = await Promise.allSettled([
      manager.approveTask(first.task_id, {kind: 'agy-level', level: 'accept-edits'}),
      manager.approveTask(first.task_id, {kind: 'agy-level', level: 'accept-edits'})
    ]);
    assert.deepEqual(results.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /already run again/);
    const created = (results.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<{task: {task_id: string}}>).value.task.task_id;
    await manager.wait(created);
    assert.equal(launches.length, 2, 'one original run and one rerun');
    await assert.rejects(manager.dismissApproval(first.task_id), /already run again/);
  } finally { await finish(); }
});

test('dismissing a refusal closes it without running anything, and is logged', async () => {
  const {state, manager, launches, run, finish} = await setup('antigravity');
  try {
    const first = await run();
    const summary = await manager.dismissApproval(first.task_id);
    assert.equal(summary.approval?.state, 'dismissed');
    assert.equal(manager.approvals()[0].state, 'dismissed');
    assert.equal(launches.length, 1);
    await assert.rejects(manager.approveTask(first.task_id, {kind: 'agy-level', level: 'auto'}), /already dismissed/);
    const [latest] = await readDecisions(state);
    assert.deepEqual([latest.action, latest.ok, latest.task_id], ['dismiss', true, first.task_id]);
  } finally { await finish(); }
});

test('codex: the granted directory reaches only the rerun, must exist, and a refusal the CLI reported is queued', async () => {
  const {root, manager, launches, run, finish} = await setup('codex');
  try {
    const first = await run();
    assert.equal(first.status, 'failed', 'a declined command fails a codex task');
    assert.equal(manager.approvals()[0].family, 'codex');
    assert.equal(manager.approvals()[0].options[0].needs_dir, true);

    await assert.rejects(manager.approveTask(first.task_id, {kind: 'codex-add-dir', dir: path.join(root, 'missing')}), /does not exist/);
    await assert.rejects(manager.approveTask(first.task_id, {kind: 'codex-add-dir', dir: 'relative'}), /absolute/);
    await assert.rejects(manager.approveTask(first.task_id, {kind: 'codex-add-dir', dir: path.parse(root).root}), /root/);
    assert.equal(launches.length, 1);

    const granted = path.join(root, 'granted'); await mkdir(granted);
    const approved = await manager.approveTask(first.task_id, {kind: 'codex-add-dir', dir: granted});
    await manager.wait(approved.task.task_id);
    const args = launches[1].args;
    assert.equal(args[args.indexOf('--add-dir') + 1], granted);
    assert.ok(!launches[0].args.includes('--add-dir'), 'the first run was not widened');
  } finally { await finish(); }
});

test('opencode: a permission it auto-rejected is queued on a completed task, and the grant reaches only the rerun\'s environment', async () => {
  const {manager, launches, run, finish} = await setup('opencode');
  try {
    const first = await run();
    assert.equal(first.status, 'completed', 'the run finished; only the refused call is on the record');
    assert.deepEqual(first.denied_actions, [{action: 'shell', display_name: 'shell: echo IN_OK > inside.txt'}]);
    const [queued] = manager.approvals();
    assert.deepEqual(queued.options.map(option => option.elevation), [{kind: 'opencode-allow', permission: 'bash'}, {kind: 'opencode-auto'}]);

    await assert.rejects(manager.approveTask(first.task_id, {kind: 'opencode-allow', permission: 'edit'}), /was not refused "edit"/);
    const approved = await manager.approveTask(first.task_id, {kind: 'opencode-allow', permission: 'bash'});
    await manager.wait(approved.task.task_id);
    assert.equal(launches[0].env?.OPENCODE_CONFIG_CONTENT, undefined, 'the first run had no permission config of its own');
    assert.deepEqual(JSON.parse(launches[1].env!.OPENCODE_CONFIG_CONTENT), {permission: {bash: 'allow'}});
    assert.ok(!launches[1].args.includes('--auto'));
  } finally { await finish(); }
});

test('over HTTP the owner can read and settle the queue, confirm is required, and no MCP tool can approve or elevate', async () => {
  const {workspace, manager, launches, run, finish} = await setup('antigravity');
  const bridge = await startHttpBridge({manager, missions: missionsFor(manager, workspace), environment: {cli_version: 'mock', allowed_workspaces: [workspace]}, port: 0});
  const call = (p: string, init: RequestInit = {}) => fetch(`${bridge.baseUrl}/ui/api/${p}`, {...init, headers: init.body ? {'Content-Type': 'application/json'} : {}});
  const post = (p: string, body: unknown) => call(p, {method: 'POST', body: JSON.stringify(body)});
  try {
    const first = await run();
    const listed = await (await call('approvals')).json() as {approvals: {task_id: string; state: string; options: unknown[]}[]};
    assert.equal(listed.approvals[0].task_id, first.task_id);
    assert.equal(listed.approvals[0].state, 'pending');

    const elevation = {kind: 'agy-level', level: 'accept-edits'};
    assert.equal((await post(`tasks/${first.task_id}/approve`, {elevation})).status, 400, 'confirm is required');
    assert.equal((await post(`tasks/${first.task_id}/approve`, {confirm: 'yes', elevation})).status, 400, 'confirm must be exactly true');
    assert.equal((await post(`tasks/${first.task_id}/approve`, {confirm: true, elevation: {kind: 'agy-level', level: 'bogus'}})).status, 400);
    assert.equal(launches.length, 1, 'none of those started a run');

    const ok = await post(`tasks/${first.task_id}/approve`, {confirm: true, elevation});
    assert.equal(ok.status, 200);
    const body = await ok.json() as {rerun_of: string; task: {task_id: string; retry_of: string; elevation: unknown}};
    assert.equal(body.rerun_of, first.task_id);
    assert.equal(body.task.retry_of, first.task_id);
    assert.deepEqual(body.task.elevation, elevation);
    await manager.wait(body.task.task_id);

    assert.equal((await post(`tasks/${first.task_id}/dismiss`, {})).status, 400);
    assert.equal((await post(`tasks/${first.task_id}/dismiss`, {confirm: true})).status, 400, 'already settled');
    assert.equal((await call(`tasks/00000000-0000-4000-8000-000000000000/approve`, {method: 'POST', body: JSON.stringify({confirm: true, elevation})})).status, 404);

    // The MCP surface: nothing to read the queue, approve, rerun or raise a permission with, and the delegate tool will not take the fields.
    const client = new Client({name: 'approvals-test', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)));
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.deepEqual(names.filter(name => /approv|elevat|rerun|retry|dismiss|permission/i.test(name)), []);
      for (const extra of [{elevation}, {retry_of: first.task_id}]) {
        const result = await client.callTool({name: 'antigravity_delegate', arguments: {task: 'x', workspace, acceptance_criteria: ['y'], agent: 'antigravity', ...extra}});
        assert.equal(result.isError, true, `delegate must refuse ${Object.keys(extra)[0]}`);
      }
      assert.equal(launches.length, 2, 'the refused delegate calls started nothing');
    } finally { await client.close(); }
  } finally { await bridge.close(); await finish(); }
});
