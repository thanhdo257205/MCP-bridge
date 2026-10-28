import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isHardTask, isQuotaError, ProfileHealthTracker } from '../src/agents/quota.js';
import { poolSchema, type Config } from '../src/config.js';
import { TaskManager } from '../src/tasks/manager.js';
import type { AgentAdapter, AgentRuntime, AgentStatus } from '../src/agents/types.js';

test('isHardTask accurately identifies complex tasks vs simple tasks', () => {
  // Simple task
  assert.equal(isHardTask({
    task: 'Fix a typo',
    owns: ['src/a.ts'],
    acceptance_criteria: ['fixed']
  }), false);

  // Hard by owns count (>= 3)
  assert.equal(isHardTask({
    task: 'Update types',
    owns: ['src/a.ts', 'src/b.ts', 'src/c.ts']
  }), true);

  // Hard by criteria count (>= 4)
  assert.equal(isHardTask({
    task: 'Implement login',
    acceptance_criteria: ['oauth', 'passkey', 'session', 'mfa']
  }), true);

  // Hard by keywords
  assert.equal(isHardTask({ task: 'Refactor database models for performance' }), true);
  assert.equal(isHardTask({ task: 'Fix concurrency and deadlock issues' }), true);
  assert.equal(isHardTask({ task: 'Thực hiện tái cấu trúc module thanh toán' }), true);

  // Hard by timeout or effort
  assert.equal(isHardTask({ task: 'Normal task', timeout_seconds: 600 }), true);
  assert.equal(isHardTask({ task: 'Normal task', effort: 'high' }), true);
});

test('isQuotaError accurately matches rate limits and balance/quota exhaustion errors', () => {
  assert.equal(isQuotaError('Error: 429 Too Many Requests - rate_limit_exceeded'), true);
  assert.equal(isQuotaError('You exceeded your current quota, please check your plan and billing details'), true);
  assert.equal(isQuotaError('resource_exhausted: quota limit exceeded for model'), true);
  assert.equal(isQuotaError('insufficient_quota'), true);
  assert.equal(isQuotaError('credits exhausted'), true);

  // Normal non-quota errors
  assert.equal(isQuotaError('SyntaxError: Unexpected token'), false);
  assert.equal(isQuotaError('File not found: src/index.ts'), false);
  assert.equal(isQuotaError('Command failed with exit code 1'), false);
});

test('ProfileHealthTracker manages cooldown and prefers hard_task_profile for hard tasks', () => {
  const tracker = new ProfileHealthTracker();
  const pool = poolSchema.parse({
    strategy: 'quota-adaptive',
    members: ['backup-acc', 'vip-acc'],
    hard_task_profile: 'vip-acc',
    quota_cooldown_seconds: 60
  });

  const available = (id: string) => true;

  // Normal task -> picks first member (backup-acc)
  assert.equal(tracker.selectProfile(pool, false, available), 'backup-acc');

  // Hard task -> picks hard_task_profile (vip-acc)
  assert.equal(tracker.selectProfile(pool, true, available), 'vip-acc');

  // If backup-acc hits quota exhaustion:
  tracker.markCooldown('backup-acc', 60);
  assert.equal(tracker.isAvailable('backup-acc'), false);

  // Now even normal tasks route to vip-acc
  assert.equal(tracker.selectProfile(pool, false, available), 'vip-acc');

  // Clearing cooldown restores backup-acc
  tracker.clearCooldown('backup-acc');
  assert.equal(tracker.isAvailable('backup-acc'), true);
  assert.equal(tracker.selectProfile(pool, false, available), 'backup-acc');
});

test('TaskManager routes hard task to hard_task_profile and auto-fails over on quota exhaustion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agy-smart-pool-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const state = path.join(root, 'state');

  const createMockAgent = (id: string, shouldFailQuota: boolean): AgentRuntime => {
    const adapter: AgentAdapter = {
      id,
      label: id,
      family: 'codex',
      capabilities: ['code'],
      buildInvocation: (task) => ({ executable: 'mock', args: [], stdin: task.prompt }),
      parseResult: async (raw) => {
        if (shouldFailQuota) {
          return {
            success: false,
            response: null,
            error: 'rate_limit_exceeded: 429 quota exhausted',
            cliStatus: 'failed',
            numTurns: 0,
            deniedActions: [],
            isQuotaExceeded: true
          };
        }
        return {
          success: true,
          response: `Success by ${id}`,
          error: null,
          cliStatus: 'completed',
          numTurns: 1,
          deniedActions: []
        };
      }
    };

    const status: AgentStatus = {
      id, label: id, available: true, version: '1.0', executable: 'mock', capabilities: ['code'], warnings: []
    };

    return {
      adapter,
      status,
      enabled: true,
      launch: (args, cwd, opts) => {
        const ee = new EventEmitter() as any;
        ee.pid = 1000 + Math.floor(Math.random() * 8000);
        ee.stdout = new PassThrough();
        ee.stderr = new PassThrough();
        ee.stdin = new PassThrough();
        ee.exitCode = 0;
        setTimeout(() => {
          if (shouldFailQuota) {
            ee.stderr.end('429 rate_limit_exceeded: insufficient_quota\n');
            ee.emit('close', 1, null);
          } else {
            ee.stdout.end('done\n');
            ee.emit('close', 0, null);
          }
        }, 30);
        return ee;
      }
    };
  };

  const agentBackup = createMockAgent('acc-backup', true); // Will hit quota limit
  const agentVip = createMockAgent('acc-vip', false);       // Will succeed

  const config: Config = {
    allowed_workspaces: [workspace], executable: 'mock',
    max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, max_parallel_worktrees: 2, default_autonomy: 'auto',
    extra_env_passthrough: [], prompt_transport: 'argv',
    agents: {
      enabled: ['acc-backup', 'acc-vip'],
      priority: ['acc-backup', 'acc-vip'],
      pools: {
        'smart-pool': {
          strategy: 'quota-adaptive',
          members: ['acc-backup', 'acc-vip'],
          hard_task_profile: 'acc-vip',
          quota_cooldown_seconds: 60
        }
      }
    }
  };

  const manager = new TaskManager(config, {
    executable: 'mock', supported: true, stateDirectory: state,
    agents: [agentBackup, agentVip], defaultAgent: 'acc-backup'
  });

  try {
    // 1. Test Hard Task routing: High effort task to smart-pool routes directly to acc-vip!
    const hardTask = await manager.delegate({
      task: 'Refactor core architecture with concurrency optimization',
      workspace,
      acceptance_criteria: ['a', 'b', 'c', 'd'],
      agent: 'smart-pool'
    });
    assert.equal(hardTask.agent, 'acc-vip', 'Hard task should route directly to hard_task_profile acc-vip');
    const hardDone = await manager.wait(hardTask.task_id);
    assert.equal(hardDone.status, 'completed');
    assert.equal(hardDone.final_response?.trim(), 'Success by acc-vip');

    // 2. Test Auto-Failover: Normal task starts with acc-backup, hits quota limit, and auto-fails over to acc-vip!
    const normalTask = await manager.delegate({
      task: 'Fix a minor typo',
      workspace,
      acceptance_criteria: ['fixed'],
      agent: 'smart-pool'
    });
    // Task started with acc-backup
    const normalDone = await manager.wait(normalTask.task_id);
    // After auto-failover, it completed via acc-vip!
    assert.equal(normalDone.status, 'completed', 'Task should succeed via auto-failover');
    assert.equal(normalDone.agent, 'acc-vip', 'Task agent should have failed over to acc-vip');
    assert.equal(normalDone.final_response?.trim(), 'Success by acc-vip');
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
