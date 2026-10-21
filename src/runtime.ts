import path from 'node:path';
import { loadConfig, projectRoot } from './config.js';
import { findExecutable, inspectCli } from './antigravity/process.js';
import { TaskManager } from './tasks/manager.js';

export async function createRuntime() {
  const config = await loadConfig();
  let cli = {version: 'unavailable', executable: '', supported: false};
  try { cli = await inspectCli(await findExecutable(config.executable), projectRoot); }
  catch { console.error('[bridge] CLI unavailable or inspection failed'); }
  const manager = new TaskManager(config, {...cli, stateDirectory: path.join(projectRoot, '.bridge-state')});
  const environment = {
    cli_version: cli.version, executable: cli.executable,
    bridge_status: cli.supported ? 'ready' : 'unsupported',
    execution_method: cli.supported ? 'supervised-print-json' : null,
    transport: 'streamable-http',
    supported: {delegate: cli.supported, status: true, output: true, cancel_owned_process: true, detached_resume: false},
    allowed_workspaces: config.allowed_workspaces,
    authentication: 'Cached CLI authentication required; only a live task verifies it.',
    limits: {max_timeout_seconds: config.max_timeout_seconds, max_output_bytes_per_stream: config.max_output_bytes, max_retained_tasks: config.max_retained_tasks, concurrent_tasks: 1},
    limitations: [
      'Only locally verified agy 1.4.3 is enabled.',
      'Client disconnect does not cancel accepted tasks. Shared task history is in server memory; restart loses it.',
      'CLI SUCCESS/exit 0 does not establish acceptance; tool permissions may have been denied.',
      'Workspace preflight is not an OS sandbox and cannot prevent concurrent link swaps.',
      'Existing Antigravity permissions, hooks, MCP and credential access remain governed by its configuration.',
      'No permission bypass flags. Dangerous actions require separate interactive approval.',
      'Windows uses taskkill on the live owned child tree; abrupt server termination may orphan processes.',
      'Redaction recognizes known patterns only. Never include credentials in task data.'
    ]
  };
  return {manager, environment};
}
