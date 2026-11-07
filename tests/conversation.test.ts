import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { antigravityAdapter } from '../src/agents/antigravity.js';
import { codexAgent } from '../src/agents/codex.js';
import { delegateSchema } from '../src/security/input.js';
import type { AgentRuntime } from '../src/agents/types.js';
import type { Config } from '../src/config.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs', import.meta.url));
const CONVERSATION = '3f2a9b1c-7d4e-4c5a-9b8f-1e2d3c4b5a69';

/** The fixture is started with the adapter's own argv after the scenario, so a test can read back the flags agy would receive. */
const forward = (args: string[], cwd: string) => startProcess(process.execPath, [fixture, 'conversation', ...args], cwd);

async function setup(workspaces = 1) {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-conversation-'));
  const paths: string[] = [];
  for (let i = 0; i < workspaces; i += 1) {
    const directory = path.join(root, `work${i}`);
    await mkdir(directory, {recursive: true});
    paths.push(directory);
  }
  const config: Config = {
    allowed_workspaces: paths, executable: process.execPath, max_timeout_seconds: 15, default_timeout_seconds: 5,
    max_output_bytes: 262144, max_retained_tasks: 10, max_queued_tasks: 0, extra_env_passthrough: [], prompt_transport: 'argv'
  };
  const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: path.join(root, 'state'), launch: forward});
  return {root, workspace: paths[0]!, second: paths[1] ?? null, config, manager};
}

/** A manager whose Antigravity was probed and found without `--conversation`, plus an available Codex for the family check. */
function antigravityRuntime(status: Partial<AgentRuntime['status']> = {}): AgentRuntime {
  return {
    adapter: antigravityAdapter(process.execPath, 'argv'),
    status: {id: 'antigravity', label: 'Antigravity', available: true, version: '1.4.12', executable: null,
      capabilities: ['code'], warnings: [], ...status},
    enabled: true, launch: forward
  };
}

test('the agy conversation id is kept on the finished task', async () => {
  const {manager, workspace} = await setup();
  const started = await manager.delegate({task: 'Implement it', workspace, acceptance_criteria: ['Verified']});
  const done = await manager.wait(started.task_id);
  assert.equal(done.status, 'completed');
  assert.equal(done.conversation_id, CONVERSATION);
  await manager.shutdown();
});

test('resume_conversation continues it and the flag reaches the CLI', async () => {
  const {manager, workspace} = await setup();
  const first = await manager.wait((await manager.delegate({task: 'Implement it', workspace, acceptance_criteria: ['Verified']})).task_id);
  const second = await manager.wait((await manager.delegate({
    task: 'Fix the defect you left', workspace, acceptance_criteria: ['Verified'], resume_conversation: first.conversation_id ?? undefined
  })).task_id);
  assert.equal(second.status, 'completed');
  assert.equal(second.final_response, 'continued', 'the CLI was handed --conversation with that id');
  assert.equal(second.conversation_id, first.conversation_id);
  assert.equal(manager.detail(second.task_id).request?.resume_conversation, first.conversation_id);
  await manager.shutdown();
});

test('a conversation the bridge never ran cannot be resumed', async () => {
  const {manager, workspace} = await setup();
  await assert.rejects(
    () => manager.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], resume_conversation: '11111111-1111-4111-8111-111111111111'}),
    /not a conversation this bridge ran/);
  await manager.shutdown();
});

test('a conversation is not carried into another workspace', async () => {
  const {manager, workspace, second} = await setup(2);
  const first = await manager.wait((await manager.delegate({task: 'Implement it', workspace, acceptance_criteria: ['Verified']})).task_id);
  await assert.rejects(
    () => manager.delegate({task: 'x', workspace: second!, acceptance_criteria: ['ok'], resume_conversation: first.conversation_id ?? undefined}),
    /created in another workspace/);
  await manager.shutdown();
});

test('only Antigravity can continue a conversation', async () => {
  const {workspace, config} = await setup();
  const codex: AgentRuntime = codexAgent({executable: 'codex', prefixArgs: [], source: 'codex'}, {
    id: 'codex', label: 'Codex', available: true, version: '0.0.0', executable: 'codex', capabilities: ['code'], warnings: []
  });
  const manager = new TaskManager(config, {
    executable: process.execPath, supported: true, stateDirectory: path.join(workspace, '..', 'state-codex'),
    agents: [antigravityRuntime(), codex]
  });
  const first = await manager.wait((await manager.delegate({task: 'Implement it', workspace, acceptance_criteria: ['Verified']})).task_id);
  assert.equal(first.agent, 'antigravity');
  await assert.rejects(
    () => manager.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], agent: 'codex', resume_conversation: first.conversation_id ?? undefined}),
    /resume_conversation needs Antigravity/);
  await manager.shutdown();
});

test('a probed CLI without --conversation refuses rather than failing in the CLI', async () => {
  // `conversation_resume:false` is the probe's verdict, not a claim about a release: every agy help this bridge has
  // measured (1.4.3 and 1.5.1) lists `--conversation`. The version string is synthetic for that reason.
  const {workspace, config} = await setup();
  const manager = new TaskManager(config, {
    executable: process.execPath, supported: true, stateDirectory: path.join(workspace, '..', 'state-gated'),
    agents: [antigravityRuntime({version: '1.4.0-unmeasured', conversation_resume: false})]
  });
  const first = await manager.wait((await manager.delegate({task: 'Implement it', workspace, acceptance_criteria: ['Verified']})).task_id);
  assert.equal(first.conversation_id, CONVERSATION);
  await assert.rejects(
    () => manager.delegate({task: 'x', workspace, acceptance_criteria: ['ok'], resume_conversation: CONVERSATION}),
    /cannot continue a conversation/);
  await manager.shutdown();
});

test('agents_list tells the client whether resume is offered', async () => {
  const {workspace, config} = await setup();
  const codex: AgentRuntime = codexAgent({executable: 'codex', prefixArgs: [], source: 'codex'}, {
    id: 'codex', label: 'Codex', available: true, version: '0.0.0', executable: 'codex', capabilities: ['code'], warnings: []
  });
  const manager = new TaskManager(config, {
    executable: process.execPath, supported: true, stateDirectory: path.join(workspace, '..', 'state-list'),
    agents: [antigravityRuntime({conversation_resume: true}), codex]
  });
  const [antigravity, codexStatus] = manager.agentsOverview().agents;
  assert.equal(antigravity.conversation_resume, true, 'a probed CLI with --conversation is advertised as resumable');
  assert.equal(codexStatus.conversation_resume, undefined, 'a family that reports no conversation id advertises nothing');
  await manager.shutdown();
});

test('resume_conversation must be a conversation id', () => {
  for (const value of ['not-a-uuid', `${CONVERSATION} --print`, CONVERSATION.slice(0, 30)]) {
    assert.equal(delegateSchema.safeParse({task: 'x', workspace: 'x', acceptance_criteria: ['ok'], resume_conversation: value}).success, false);
  }
  assert.equal(delegateSchema.safeParse({task: 'x', workspace: 'x', acceptance_criteria: ['ok'], resume_conversation: CONVERSATION}).success, true);
});

test('--conversation goes before the prompt, which agy takes as the argument after --print', () => {
  const adapter = antigravityAdapter('agy', 'argv');
  const invocation = adapter.buildInvocation({
    prompt: 'do it', workspace: '/tmp/work', timeoutSeconds: 10, autonomy: 'auto', owns: [],
    taskId: '22222222-2222-4222-8222-222222222222', stateDirectory: '/tmp/state', conversationId: CONVERSATION
  });
  assert.deepEqual(invocation.args.slice(0, 4), ['--conversation', CONVERSATION, '--print', 'do it']);
  const fresh = adapter.buildInvocation({
    prompt: 'do it', workspace: '/tmp/work', timeoutSeconds: 10, autonomy: 'auto', owns: [],
    taskId: '22222222-2222-4222-8222-222222222222', stateDirectory: '/tmp/state'
  });
  assert.equal(fresh.args[0], '--print', 'a task that does not ask for a conversation starts a new one');
});
