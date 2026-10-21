import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { delegateSchema, taskIdSchema } from '../security/input.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';

export function createServer(manager: TaskManager, environment: Record<string, unknown>): McpServer {
  const server = new McpServer({name: 'codex-antigravity-bridge', version: '0.1.0'});
  const response = (value: Record<string, unknown>) => ({content: [{type: 'text' as const, text: JSON.stringify(value)}], structuredContent: value});
  const guard = async (action: () => Promise<unknown> | unknown) => {
    try { return response(await action() as Record<string, unknown>); }
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
    description: 'Get task/process state and bounded logs. Accepted tasks survive client disconnect; history lasts until server restart or retention expiry.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.get(task_id)));
  server.registerTool('antigravity_task_output', {
    description: 'Get final response or partial logs, errors and truncation metadata. Does not wait for completion.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.get(task_id)));
  server.registerTool('antigravity_cancel_task', {
    description: 'Terminate only the managed task process tree. Partial file changes remain; no automatic rollback.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => manager.cancel(task_id)));
  return server;
}
