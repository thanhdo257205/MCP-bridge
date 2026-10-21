import path from 'node:path';
import { loadConfig, sessionOnlyWorkspaces } from './config.js';
import { helperDirectory, paths } from './paths.js';
import { findExecutable, inspectCli, startProcess } from './antigravity/process.js';
import { TaskManager } from './tasks/manager.js';
import {recoverExecutionLock} from './tasks/execution-lock.js';

export async function createRuntime() {
  const config = await loadConfig();
  let cli = {version: 'unavailable', executable: '', supported: false, warnings: [] as string[]};
  try { cli = await inspectCli(await findExecutable(config.executable), helperDirectory(), (executable,args,cwd)=>startProcess(executable,args,cwd,{extraEnvPassthrough:config.extra_env_passthrough}), config.prompt_transport==='stdin'); }
  catch { console.error('[bridge] CLI unavailable or inspection failed'); }
  for(const warning of cli.warnings)console.error(`[bridge] WARNING: ${warning}`);
  const manager = new TaskManager(config, {...cli, stateDirectory: paths.stateDirectory});
  await recoverExecutionLock(paths.stateDirectory);
  const restored = await manager.restore();
  if (restored) console.error(`[bridge] Restored ${restored} finished task record(s) from .bridge-state/tasks`);
  const lockWarning = await manager.lockDiagnostic();
  if (lockWarning) console.error(`[bridge] WARNING: ${lockWarning}`);
  const environment = {
    cli_version: cli.version, executable: cli.executable,
    bridge_status: cli.supported ? 'ready' : 'unsupported',
    execution_method: cli.supported ? (config.prompt_transport==='stdin'?'supervised-stdin-stream-json':'supervised-print-json') : null,
    transport: 'streamable-http',
    supported: {delegate: cli.supported, status: true, wait: true, output: true, cancel_owned_process: true, detached_resume: false},
    allowed_workspaces: config.allowed_workspaces, session_workspaces: sessionOnlyWorkspaces(),
    authentication: 'Cached CLI authentication required; only a live task verifies it.',
    limits: {max_timeout_seconds: config.max_timeout_seconds, max_output_bytes_per_stream: config.max_output_bytes, max_retained_tasks: config.max_retained_tasks, concurrent_tasks: 1, max_queued_tasks: config.max_queued_tasks, max_wait_seconds: manager.maxWaitSeconds},
    limitations: [
      'Only agy 1.4.x with all required flags is enabled; real agent execution was verified on 1.4.3.',
      ...cli.warnings,
      'Client disconnect does not cancel accepted tasks. Finished-task records persist in .bridge-state/tasks; a task running during a restart is marked failed and its process is not recovered.',
      'CLI SUCCESS/exit 0 does not establish acceptance; tool permissions may have been denied.',
      'Workspace preflight is not an OS sandbox and cannot prevent concurrent link swaps.',
      'Existing Antigravity permissions, hooks, MCP and credential access remain governed by its configuration.',
      'Permission flags are off unless the bridge owner raises the Antigravity permission level in the web UI (agy_permissions shows the current level; a client cannot change it). At the default level, actions that need approval are denied (see denied_actions).',
      'Windows uses taskkill on the live owned child tree; abrupt server termination may orphan processes.',
      'Redaction recognizes known patterns only. Never include credentials in task data.'
    ]
  };
  return {manager, environment};
}
