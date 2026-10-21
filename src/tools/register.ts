import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, delegateSchema, taskIdSchema, waitSchema } from '../security/input.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';

export function createServer(manager: TaskManager, environment: Record<string, unknown>): McpServer {
  const server = new McpServer({name: 'antigravity-mcp-bridge', version: '0.1.0'});
  const response = <T extends object>(value: T) => ({content: [{type: 'text' as const, text: JSON.stringify(value)}], structuredContent: value as Record<string, unknown>});
  const guard = async <T extends object>(action: () => Promise<T> | T) => {
    try { return response(await action()); }
    catch (error) { return {...response({error: redact(error instanceof Error ? error.message : 'Bridge operation failed')}), isError: true}; }
  };
  server.registerTool('antigravity_environment', {
    description: 'Inspect verified CLI capabilities. Does not prove current authentication or task acceptance.',
    inputSchema: z.object({}).strict(), annotations: {readOnlyHint: true, openWorldHint: false}
  }, async () => response({...environment, ...manager.overview()}));
  server.registerTool('antigravity_delegate', {
    description: 'Start one supervised agy print task. Returns running with task_id; poll status/output. Completion always needs Tech Lead diff/test review. Never authorize destructive/system/deploy actions with this tool.',
    inputSchema: delegateSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true}
  }, async input => guard(() => manager.delegate(input)));
  server.registerTool('antigravity_task_status', {
    description: 'Get task/process state, timing, error, denied_actions and byte counts without logs (cheap to poll). Accepted tasks survive client disconnect; finished-task history is kept on disk across restarts until retention expiry.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.summary(task_id)));
  server.registerTool('antigravity_task_wait', {
    description: `Wait up to wait_seconds (1-${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}) for the task to finish, then return its status without logs. Returns early when the task ends; if still running, call again. Does not cancel the task.`,
    inputSchema: waitSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id, wait_seconds}) => guard(async () => {
    await manager.waitFor(task_id, wait_seconds ?? DEFAULT_WAIT_SECONDS);
    return manager.summary(task_id);
  }));
  server.registerTool('antigravity_task_output', {
    description: 'Get final response, partial stdout/stderr logs, errors and truncation metadata. Does not wait for completion.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.get(task_id)));
  server.registerTool('antigravity_cancel_task', {
    description: 'Terminate only the managed task process tree. Partial file changes remain; no automatic rollback.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.cancel(task_id)));
  return server;
}
