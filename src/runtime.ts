import { loadConfig, sessionOnlyWorkspaces } from './config.js';
import { helperDirectory, paths } from './paths.js';
import { inspectCli, resolveCommand, startProcess, VERIFIED_AGY_VERSIONS } from './antigravity/process.js';
import { createAgentRegistry, publicAgents, type AntigravityInspection } from './agents/registry.js';
import { TaskManager } from './tasks/manager.js';
import {sweepStaleWorktrees} from './isolation/worktree.js';
import {startTreeWatch} from './isolation/orphans.js';
import {recoverExecutionLock} from './tasks/execution-lock.js';

export async function createRuntime() {
  const config = await loadConfig();
  let cli = {version: 'unavailable', executable: '', supported: false, warnings: [] as string[]};
  let antigravity: AntigravityInspection = {version: 'unavailable', executable: '', supported: false, warnings: []};
  try {
    const command = await resolveCommand(config.executable);
    cli = await inspectCli(command.executable, helperDirectory(), (executable,args,cwd)=>startProcess(executable,args,cwd,{extraEnvPassthrough:config.extra_env_passthrough}), config.prompt_transport==='stdin');
    antigravity = {...cli, executable: cli.executable || command.source};
  } catch {
    antigravity = {version: 'unavailable', executable: '', supported: false, warnings: ['Antigravity CLI unavailable or inspection failed']};
    console.error('[bridge] CLI unavailable or inspection failed');
  }
  for(const warning of antigravity.warnings)console.error(`[bridge] WARNING: ${warning}`);

  const registry = await createAgentRegistry(config, antigravity);
  for (const warning of registry.warnings) console.error(`[bridge] WARNING: ${warning}`);
  for (const agent of registry.agents) {
    const state = !agent.enabled ? 'disabled' : agent.status.available ? `ready${agent.status.version ? ` ${agent.status.version}` : ''}` : 'unavailable';
    console.error(`[bridge] Agent ${agent.adapter.id}: ${state}`);
  }

  const maxParallelWorktrees = config.max_parallel_worktrees ?? 2;
  const manager = new TaskManager(config, {
    executable: antigravity.executable, supported: antigravity.supported, stateDirectory: paths.stateDirectory,
    agents: registry.agents, defaultAgent: registry.defaultAgent,
    // Without the watch the release can only name the processes that still hang below the agent at the moment it
    // exits, which is exactly the case that left the worktree pinned in a live run.
    watchTree: startTreeWatch
  });
  await recoverExecutionLock(paths.stateDirectory);
  const sweep = await sweepStaleWorktrees(paths.stateDirectory);
  for (const removed of sweep.removed) console.error(`[bridge] Removed a stale empty worktree directory: ${removed}`);
  for (const kept of sweep.retained) console.error(`[bridge] Kept worktree directory ${kept.path}: ${kept.reason}`);
  const restored = await manager.restore();
  if (restored) console.error(`[bridge] Restored ${restored} finished task record(s) from .bridge-state/tasks`);
  const lockWarning = await manager.lockDiagnostic();
  if (lockWarning) console.error(`[bridge] WARNING: ${lockWarning}`);

  const anyAgent = registry.defaultAgent !== null;
  const environment = {
    cli_version: antigravity.version, executable: antigravity.executable,
    bridge_status: antigravity.supported ? 'ready' : 'unsupported',
    execution_method: antigravity.supported ? (config.prompt_transport==='stdin'?'supervised-stdin-stream-json':'supervised-print-json') : null,
    transport: 'streamable-http',
    agents: publicAgents(registry.agents),
    default_agent: registry.defaultAgent,
    max_parallel_worktrees: maxParallelWorktrees,
    default_autonomy: config.default_autonomy ?? 'auto',
    supported: {delegate: anyAgent, status: true, wait: true, output: true, cancel_owned_process: true, agents_list: true, worktree_isolation: true, detached_resume: false},
    allowed_workspaces: config.allowed_workspaces, session_workspaces: sessionOnlyWorkspaces(),
    authentication: 'Each agent CLI uses its own cached login; only a live task verifies it.',
    limits: {max_timeout_seconds: config.max_timeout_seconds, max_output_bytes_per_stream: config.max_output_bytes, max_retained_tasks: config.max_retained_tasks, concurrent_tasks: maxParallelWorktrees + 1, concurrent_normal_tasks: 1, max_parallel_worktrees: maxParallelWorktrees, max_queued_tasks: config.max_queued_tasks},
    limitations: [
      `Antigravity requires agy 1.4.x with all required flags; real execution was verified on ${VERIFIED_AGY_VERSIONS.join(' and ')}.`,
      'Codex runs non-interactively with sandbox workspace-write; approval-requiring actions still fail instead of bypassing the sandbox.',
      'Ordinary tasks are serialized globally. Only tasks with isolation "worktree" run concurrently, each in its own git worktree and branch.',
      'Worktree tasks declare owns; files outside that list are reported for review and are never merged automatically.',
      ...antigravity.warnings,
      'Client disconnect does not cancel accepted tasks. Finished-task records persist in .bridge-state/tasks; a task running during a restart is marked failed and its process is not recovered.',
      'CLI SUCCESS/exit 0 does not establish acceptance; tool permissions may have been denied.',
      'Workspace preflight is not an OS sandbox and cannot prevent concurrent link swaps.',
      'Existing agent permissions, hooks, MCP and credential access remain governed by each CLI configuration.',
      'Antigravity permission flags are off unless the bridge owner raises the level in the web UI (a client cannot change it). At the default level, actions that need approval are denied (see denied_actions).',
      'No permission bypass flags. Dangerous actions require separate interactive approval.',
      'After an agent process exits, the bridge releases the process trees it left behind (Windows: taskkill on every subtree still hanging below the agent or below a process recorded while it ran; POSIX: the exited process group). A bridge killed abruptly can still orphan processes.',
      'Worktree directories of finished tasks are kept for review. Only empty leftovers are removed at startup, and a directory a live process still holds is reported instead of forced.',
      'Redaction recognizes known patterns only. Never include credentials in task data.'
    ]
  };
  return {manager, environment};
}
