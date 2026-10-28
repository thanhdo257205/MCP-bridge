import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TaskManager } from '../src/tasks/manager.js';
import { agentProfileSchema, codexSandboxSchema, codexApprovalSchema } from '../src/config.js';
import { codexAdapter } from '../src/agents/codex.js';
import { antigravityAdapter } from '../src/agents/antigravity.js';
import { createAgentRegistry, publicAgents, type AntigravityInspection } from '../src/agents/registry.js';
import { childEnvironment } from '../src/antigravity/process.js';
import { globalHealthTracker } from '../src/agents/quota.js';
import type { AgentRuntime } from '../src/agents/types.js';
import type { ChildProcess } from 'node:child_process';
import type { Config } from '../src/config.js';

test('agent profile schema accepts valid profiles with custom env, sandbox and approval', () => {
  const profile = agentProfileSchema.parse({
    adapter: 'codex',
    label: 'Codex Work',
    env: {
      CODEX_HOME: 'C:\\Users\\test\\.codex-work'
    },
    codex_sandbox: 'danger-full-access',
    codex_ask_for_approval: 'never',
    model: 'gpt-5-turbo'
  });
  assert.equal(profile.adapter, 'codex');
  assert.equal(profile.env?.CODEX_HOME, 'C:\\Users\\test\\.codex-work');
  assert.equal(profile.codex_sandbox, 'danger-full-access');
  assert.equal(profile.codex_ask_for_approval, 'never');
});

test('agent profile schema rejects invalid sandbox or approval enum values', () => {
  assert.throws(() => codexSandboxSchema.parse('invalid-sandbox'));
  assert.throws(() => codexApprovalSchema.parse('maybe'));
  // codex-cli 0.163.0 accepts only on-request and never; 'auto' and 'always' would exit with "invalid value".
  for (const value of ['auto', 'always', 'untrusted', 'on-failure']) assert.throws(() => codexApprovalSchema.parse(value));
  for (const value of ['on-request', 'never']) assert.equal(codexApprovalSchema.parse(value), value);
});

test('childEnvironment strips secrets but startProcess customEnv allows profile variables', () => {
  const baseEnv = {
    PATH: '/bin:/usr/bin',
    USERPROFILE: '/home/user',
    API_KEY: 'secret123'
  };
  const filtered = childEnvironment(baseEnv);
  assert.equal(filtered.PATH, '/bin:/usr/bin');
  assert.equal(filtered.API_KEY, undefined);

  // In startProcess, customEnv is merged onto childEnvironment:
  const merged = { ...filtered, CODEX_HOME: '/home/user/.codex-b' };
  assert.equal(merged.CODEX_HOME, '/home/user/.codex-b');
});

test('codexAdapter buildInvocation passes configured sandbox, approval and customEnv', () => {
  const dummyCmd = { executable: 'codex', prefixArgs: [], source: 'codex' };
  const adapter = codexAdapter(dummyCmd, {
    id: 'codex-work',
    label: 'Codex (Work)',
    sandbox: 'danger-full-access',
    askForApproval: 'never',
    env: { CODEX_HOME: 'C:\\test\\.codex-work' }
  });

  assert.equal(adapter.id, 'codex-work');
  assert.equal(adapter.label, 'Codex (Work)');

  const invocation = adapter.buildInvocation({
    prompt: 'Fix a bug',
    workspace: 'C:\\repo',
    timeoutSeconds: 300,
    autonomy: 'auto',
    owns: ['src/file.ts'],
    taskId: '12345678-1234-1234-1234-123456789abc',
    stateDirectory: 'C:\\state'
  });

  assert.ok(invocation.args.includes('--sandbox'));
  const sandboxIdx = invocation.args.indexOf('--sandbox');
  assert.equal(invocation.args[sandboxIdx + 1], 'danger-full-access');

  assert.ok(invocation.args.includes('--ask-for-approval'));
  const approvalIdx = invocation.args.indexOf('--ask-for-approval');
  assert.equal(invocation.args[approvalIdx + 1], 'never');
  // --ask-for-approval is a global codex flag: after `exec` the CLI exits with "unexpected argument" and no task starts.
  assert.ok(approvalIdx < invocation.args.indexOf('exec'), '--ask-for-approval must precede the exec subcommand');

  assert.deepEqual(invocation.customEnv, { CODEX_HOME: 'C:\\test\\.codex-work' });
});

test('antigravityAdapter buildInvocation passes customEnv', () => {
  const adapter = antigravityAdapter('agy', 'argv', {
    id: 'antigravity-team',
    label: 'Antigravity (Team)',
    env: { GEMINI_CLI_HOME: 'C:\\test\\.gemini-team' }
  });

  assert.equal(adapter.id, 'antigravity-team');
  assert.equal(adapter.label, 'Antigravity (Team)');

  const invocation = adapter.buildInvocation({
    prompt: 'Implement feature',
    workspace: 'C:\\repo',
    timeoutSeconds: 300,
    autonomy: 'auto',
    owns: ['src/file.ts'],
    taskId: '12345678-1234-1234-1234-123456789abc',
    stateDirectory: 'C:\\state'
  });

  assert.deepEqual(invocation.customEnv, { GEMINI_CLI_HOME: 'C:\\test\\.gemini-team' });
});

test('createAgentRegistry registers profiles and warns on dangerous sandbox/approval', async () => {
  const antigravity: AntigravityInspection = {
    executable: 'agy',
    supported: true,
    version: '1.4.7',
    warnings: []
  };

  const config: Config = {
    allowed_workspaces: [],
    executable: 'agy',
    max_timeout_seconds: 900,
    default_timeout_seconds: 300,
    max_output_bytes: 262144,
    max_retained_tasks: 50,
    max_queued_tasks: 3,
    extra_env_passthrough: [],
    prompt_transport: 'argv',
    agents: {
      enabled: ['antigravity', 'codex-custom'],
      priority: ['codex-custom', 'antigravity'],
      profiles: {
        'codex-custom': {
          adapter: 'codex',
          label: 'Codex Custom Profile',
          env: {
            CODEX_HOME: 'C:\\profiles\\codex-b'
          },
          codex_sandbox: 'danger-full-access',
          codex_ask_for_approval: 'never'
        }
      }
    }
  };

  const registry = await createAgentRegistry(config, antigravity);

  // Check warnings contain danger-full-access alert
  const hasDangerWarning = registry.warnings.some(w => w.includes('danger-full-access') && w.includes('codex-custom'));
  assert.ok(hasDangerWarning, 'Should warn about danger-full-access in codex-custom');

  // Check agent list contains codex-custom
  const customAgent = registry.agents.find(a => a.adapter.id === 'codex-custom');
  assert.ok(customAgent, 'codex-custom profile must be in agents');
  assert.equal(customAgent?.adapter.label, 'Codex Custom Profile');

  // Check public representation
  const publicList = publicAgents(registry.agents);
  const publicCustom = publicList.find(a => a.id === 'codex-custom');
  assert.ok(publicCustom);
  assert.equal(publicCustom?.label, 'Codex Custom Profile');
  assert.ok(publicCustom?.warnings.some(w => w.includes('danger-full-access')));
});

test('TaskManager delegates task to specific agent profile with customEnv passed to launch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-profile-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const state = path.join(root, 'state');

  let capturedEnv: Record<string, string> | undefined;
  const dummyCmd = { executable: 'codex', prefixArgs: [], source: 'codex' };
  const adapter = codexAdapter(dummyCmd, {
    id: 'codex-work',
    label: 'Codex Work',
    sandbox: 'danger-full-access',
    askForApproval: 'never',
    env: { CODEX_HOME: 'C:\\custom\\.codex-work' }
  });

  const agent = {
    adapter,
    status: {
      id: 'codex-work', label: 'Codex Work', available: true, version: '1.0',
      executable: 'codex', capabilities: ['code' as const], warnings: []
    },
    enabled: true,
    launch: (args: string[], cwd: string, options?: any) => {
      capturedEnv = options?.customEnv;
      const ee = new EventEmitter() as any;
      ee.pid = 99999;
      ee.stdout = new PassThrough();
      ee.stderr = new PassThrough();
      ee.stdin = new PassThrough();
      ee.exitCode = 0;
      setTimeout(() => {
        ee.stdout.end('{"type":"turn.completed","status":"completed"}\n{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}\n');
        ee.emit('close', 0, null);
      }, 50);
      return ee;
    }
  };

  const config: Config = {
    allowed_workspaces: [workspace], executable: 'agy',
    max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto',
    extra_env_passthrough: [], prompt_transport: 'argv'
  };

  const manager = new TaskManager(config, {
    executable: 'agy', supported: true, stateDirectory: state, agents: [agent], defaultAgent: 'codex-work'
  });

  try {
    const started = await manager.delegate({
      task: 'do profile work',
      workspace,
      acceptance_criteria: ['done'],
      agent: 'codex-work'
    });
    assert.equal(started.agent, 'codex-work');
    const done = await manager.wait(started.task_id);
    assert.equal(done.status, 'completed');
    assert.equal(done.agent, 'codex-work');
    assert.deepEqual(capturedEnv, { CODEX_HOME: 'C:\\custom\\.codex-work' });
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

const QUOTA_LINE = '{"type":"error","message":"insufficient_quota: You exceeded your current quota, please check your plan and billing details"}';
const OK_LINES = ['{"type":"turn.completed","status":"completed"}', '{"type":"item.completed","item":{"type":"agent_message","text":"worked after failover"}}'];

/**
 * A codex profile whose fake CLI prints one JSONL transcript and closes, so the real parseResult decides the outcome.
 * `script(id, call)` returns the lines for that launch, which is how a test gives a profile a different answer on retry.
 */
function fakeProfile(id: string, launches: string[], script: (call: number) => {lines: string[]; code: number}, onLaunch?: () => void): AgentRuntime {
  const adapter = codexAdapter({executable: 'codex', prefixArgs: [], source: 'codex'}, {id, label: id});
  return {
    adapter,
    status: {id, label: id, available: true, version: '1.0', executable: 'codex', capabilities: ['code' as const], warnings: []},
    enabled: true,
    launch: () => {
      const call = launches.filter(item => item === id).length + 1;
      launches.push(id);
      onLaunch?.();
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 900_000 + launches.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      const {lines, code} = script(call);
      setTimeout(() => { child.stdout.end(`${lines.join('\n')}\n`); child.emit('close', code, null); }, 10);
      return child as unknown as ChildProcess;
    }
  };
}
function poolConfig(workspace: string): Config {
  return {
    allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10,
    max_output_bytes: 262144, max_retained_tasks: 10, max_queued_tasks: 0, max_parallel_worktrees: 2,
    default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv',
    agents: {pools: {'codex-pool': {strategy: 'quota-adaptive', members: ['p1', 'p2'], quota_cooldown_seconds: 10}}}
  } as unknown as Config;
}
/** The health tracker is a module singleton, so a cooldown left by an earlier test would change which profile a pool picks first. */
function healthyPool(): void { for (const id of ['p1', 'p2']) globalHealthTracker.clearCooldown(id); }

test('a quota failover keeps the lane it already holds and keeps the abandoned attempt as evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-failover-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const state = path.join(root, 'state');
  healthyPool();
  const launches: string[] = [];
  const secondLaunchLock: {held: boolean | null} = {held: null};
  const p1 = fakeProfile('p1', launches, () => ({lines: [QUOTA_LINE], code: 1}));
  const p2 = fakeProfile('p2', launches, () => ({lines: OK_LINES, code: 0}), () => {
    if (launches.filter(item => item === 'p2').length === 1) secondLaunchLock.held = existsSync(path.join(state, 'execution.lock'));
  });
  const manager = new TaskManager(poolConfig(workspace), {executable: 'codex', supported: true, stateDirectory: state, agents: [p1, p2], defaultAgent: 'p1'});
  try {
    const started = await manager.delegate({task: 'do the work', workspace, acceptance_criteria: ['done'], agent: 'codex-pool'});
    const done = await manager.wait(started.task_id);
    assert.deepEqual(launches, ['p1', 'p2'], 'the quota failure is retried on the next healthy profile');
    assert.equal(done.status, 'completed');
    assert.equal(done.agent, 'p2');
    assert.equal(done.error, null, 'a task that failed over and then succeeded carries no release error');
    // The retry must not publish a lane the bridge is still using: the same task holds execution.lock across both attempts.
    assert.equal(secondLaunchLock.held, true, 'the second attempt starts while the execution lock is still held');
    const abandoned = manager.get(started.task_id).attempts!;
    assert.equal(abandoned.length, 1);
    assert.equal(abandoned[0].agent, 'p1');
    assert.match(abandoned[0].error ?? '', /insufficient_quota/, 'the reason the first profile stopped is kept');
    assert.match(abandoned[0].stdout_tail, /insufficient_quota/, 'the first attempt is still readable after its log is replaced');
    assert.match(done.final_response ?? '', /worked after failover/);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('failover visits each profile in the pool at most once and then fails the task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-failover-bound-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const state = path.join(root, 'state');
  healthyPool();
  const launches: string[] = [];
  // p1's cooldown is cleared when p2 starts, so the only thing that can stop the pair from cycling forever is the
  // set of profiles this task already burned. Without it the third launch is p1 again, and it succeeds.
  const bothQuota = (call: number) => ({lines: call > 2 ? OK_LINES : [QUOTA_LINE], code: call > 2 ? 0 : 1});
  const p1 = fakeProfile('p1', launches, bothQuota);
  const p2 = fakeProfile('p2', launches, bothQuota, () => globalHealthTracker.clearCooldown('p1'));
  const manager = new TaskManager(poolConfig(workspace), {executable: 'codex', supported: true, stateDirectory: state, agents: [p1, p2], defaultAgent: 'p1'});
  try {
    const started = await manager.delegate({task: 'do the work', workspace, acceptance_criteria: ['done'], agent: 'codex-pool'});
    const done = await manager.wait(started.task_id);
    assert.deepEqual(launches, ['p1', 'p2'], 'each profile in the pool is tried once, in pool order');
    assert.equal(done.status, 'failed', 'an exhausted pool fails the task instead of looping');
    // Only the replaced attempt is archived; the last one stays in the task's own error and log.
    assert.equal(done.attempts?.length, 1);
    assert.equal(done.attempts?.[0].agent, 'p1');
    assert.match(done.error ?? '', /insufficient_quota/);
    assert.equal(done.agent, 'p2', 'the record names the profile that was last in charge');
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
