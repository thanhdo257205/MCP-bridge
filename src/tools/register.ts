import { CLIENT_INFO_META_KEY, McpServer } from '@modelcontextprotocol/server';
import { requestContext } from '../request-context.js';
import * as z from 'zod/v4';
import { delegateSchema, taskIdSchema, waitSchema } from '../security/input.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';
import {readPackageInfo} from '../update.js';

/** Best-effort label for who delegated: the client's declared name/version when the request carries it, else the HTTP User-Agent. */
function clientLabel(envelope: unknown): string | null {
  const info = (envelope as Record<string, unknown> | undefined)?.[CLIENT_INFO_META_KEY] as {name?: unknown; version?: unknown} | undefined;
  const declared = typeof info?.name === 'string' ? `${info.name}${typeof info.version === 'string' ? ` ${info.version}` : ''}` : requestContext.getStore()?.userAgent;
  // eslint-disable-next-line no-control-regex
  const clean = declared?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  return clean || null;
}

/** Said at the moment the client decides what to do next: while the task runs, waiting is the whole job (any other call costs tokens and repeats Antigravity's work). */
export const WAITING_NOTE = 'Task still running. Do nothing else: no file reads, git, tests, logs or review of this change yourself, and write no message. Call antigravity_task_wait again now.';
const withNextStep = <T extends {status: string}>(summary: T, activity: string | null = null): T | (T & {next_step: string; activity?: string}) =>
  summary.status === 'running' || summary.status === 'queued' ? {...summary, ...(activity ? {activity} : {}), next_step: WAITING_NOTE} : summary;

export function createServer(manager: TaskManager, environment: Record<string, unknown>): McpServer {
  const server = new McpServer({name: 'antigravity-mcp-bridge', version: readPackageInfo().version});
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
  }, async (input, ctx) => guard(() => manager.delegate(input, {client: clientLabel(ctx.mcpReq.envelope)})));
  server.registerTool('antigravity_task_status', {
    description: 'Get task/process state, timing, error, denied_actions and byte counts without logs (cheap to poll). Accepted tasks survive client disconnect; finished-task history is kept on disk across restarts until retention expiry.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => withNextStep(manager.summary(task_id), manager.activityNote(task_id))));
  server.registerTool('antigravity_task_wait', {
    description: `Wait up to wait_seconds (1-${manager.maxWaitSeconds}, default ${manager.maxWaitSeconds}) for the task to finish, then return its status without logs. Returns early when the task ends; if still running, call again. Does not cancel the task.`,
    inputSchema: waitSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id, wait_seconds}) => guard(async () => {
    await manager.waitFor(task_id, manager.nextWaitSeconds(task_id, wait_seconds));
    return withNextStep(manager.summary(task_id), manager.activityNote(task_id));
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
