import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
