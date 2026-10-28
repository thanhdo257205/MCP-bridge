import { CLIENT_INFO_META_KEY, McpServer } from '@modelcontextprotocol/server';
import { requestContext } from '../request-context.js';
import * as z from 'zod/v4';
import { delegateSchema, taskIdSchema, waitSchema } from '../security/input.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  missionCancelSchema, missionCreateSchema, missionDispatchSchema, missionExtendSchema, missionIdSchema,
  type MissionManager, type MissionView
} from '../missions/missions.js';
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
export const WAITING_NOTE = 'Still running. Do nothing else and write no message; call antigravity_task_wait again now.';
/**
 * A task that is still running is reported in a few fields only: the client reads this on every wait, so each field costs tokens many times over,
 * and everything else (paths, byte counts, pid...) is in the web UI and in the full status once the task has ended.
 */
const withNextStep = <T extends {status: string; task_id: string; duration_ms: number}>(summary: T, activity: string | null = null) =>
  summary.status === 'running' || summary.status === 'queued'
    ? {task_id: summary.task_id, status: summary.status, duration_ms: summary.duration_ms, ...(activity ? {activity} : {}), next_step: WAITING_NOTE}
    : summary;

/**
 * A mission step is started by a task like any other delegation, so the same rule applies after dispatch: report the four fields
 * the client needs to wait, and let the task tools carry the rest. The mission id and step id stay in the reply because the client
 * has to come back to this plan after the wait.
 */
const withStepNote = <T extends {status: string; mission_id: string; step_id: string; task_id: string; duration_ms: number}>(value: T) =>
  value.status === 'running' || value.status === 'queued'
    ? {mission_id: value.mission_id, step_id: value.step_id, task_id: value.task_id, status: value.status, duration_ms: value.duration_ms, next_step: 'Step started. Do nothing else and write no message; call antigravity_task_wait with this task_id.'}
    : value;

/** The one line that says what the orchestrator can actually do next, computed from the plan rather than repeated from a description. */
function missionNote(view: MissionView): string {
  if (view.status === 'canceled') return 'Mission is canceled: no step can be dispatched. Create a new mission to continue.';
  if (view.ready.length) return `Dispatch a ready step with mission_dispatch (${view.ready.join(', ')}), then call antigravity_task_wait on the task_id it returns.`;
  if (view.progress.active) return 'A step is running: call antigravity_task_wait on its task_id and make no other call until it ends.';
  if (view.progress.unmet) return 'No step is ready and at least one ended without completing: review that step, then add a correction step with mission_extend or cancel the mission.';
  return 'Every step reached a terminal state. Review each diff and test before accepting the mission; the bridge never merges a worktree branch.';
}

export function createServer(manager: TaskManager, environment: Record<string, unknown>, missions: MissionManager): McpServer {
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
  server.registerTool('agents_list', {
    description: 'List detected CLI agents, capabilities, availability, default agent and worktree limit. Does not change anything.',
    inputSchema: z.object({}).strict(), annotations: {readOnlyHint: true, openWorldHint: false}
  }, async () => response(manager.agentsOverview()));
  server.registerTool('antigravity_delegate', {
    description: 'Start one supervised agent task. Pick agent (default from config), isolation "worktree" plus owns paths for parallel isolated work, and autonomy. Returns running with task_id; poll status/output. Completion always needs Tech Lead diff/test review. Never authorize destructive/system/deploy actions with this tool.',
    inputSchema: delegateSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true}
  }, async (input, ctx) => guard(() => manager.delegate(input, {client: clientLabel(ctx.mcpReq.envelope)})));
  server.registerTool('antigravity_task_status', {
    description: 'Get task/process state, timing, error, denied_actions and byte counts without logs (cheap to poll). Accepted tasks survive client disconnect; finished-task history is kept on disk across restarts until retention expiry.',
    inputSchema: taskIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id}) => guard(() => withNextStep(manager.summary(task_id), manager.activityNote(task_id))));
  server.registerTool('antigravity_task_wait', {
    description: `Wait up to wait_seconds (1-${manager.maxWaitSeconds}, default ${manager.maxWaitSeconds}) for the task to finish, then return its status without logs. Returns early when the task ends; if still running, call again. Does not cancel the task.`,
    inputSchema: waitSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({task_id, wait_seconds}, ctx) => guard(async () => {
    // A client that sent a progress token gets a heartbeat while the wait is held. Clients that reset their tool timeout on progress can then
    // wait far longer than tool_timeout_sec; clients that do not simply ignore it. Never sent without a token, and a failed send never fails the wait.
    const token = ctx.mcpReq._meta?.progressToken;
    let beats = 0;
    const beat = token === undefined ? null : setInterval(() => {
      beats += 1;
      void ctx.mcpReq.notify({method: 'notifications/progress', params: {progressToken: token, progress: beats, message: manager.activityNote(task_id) ?? 'Antigravity is still working'}}).catch(() => {});
    }, manager.progressIntervalMs);
    try { await manager.waitFor(task_id, manager.nextWaitSeconds(task_id, wait_seconds)); }
    finally { if (beat) clearInterval(beat); }
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
  server.registerTool('code_search', {
    description: 'Fast codebase passage and definition search powered by XERJ local index. Returns exact matching code snippets and definitions with file paths without reading whole files (saves tokens). Requires xerj.enabled in the bridge config.',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('Code symbol, function name, class, or search query'),
      limit: z.number().int().min(1).max(20).optional().default(5).describe('Maximum number of matching code passages to return (1-20, default 5)'),
      index: z.string().min(1).max(100).optional().describe('Optional XERJ index name to search (defaults to configured index, e.g. mcp-bridge-docs)')
    }).strict(),
    annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({query, limit, index}) => guard(async () => {
    // Registered either way so the tool surface does not depend on the owner's config; the query text leaves the
    // bridge only when the owner has opted in, and a refusal says so instead of returning an empty result.
    if (!manager.isXerjEnabled()) throw new Error('XERJ search is disabled: set "xerj.enabled" to true in workspaces.json');
    return manager.getXerjClient().search(query, {limit, index});
  }));
  // Missions: the bridge records and gates the plan, the client drives it. Nothing here starts an agent on its own.
  const receipt = (mission_id: string) => {
    const view = missions.view(mission_id);
    return {mission_id, workspace: view.workspace, status: view.status, progress: view.progress, ready: view.ready, next_step: missionNote(view)};
  };
  server.registerTool('mission_create', {
    description: 'Record a dependency-ordered plan of agent tasks, all in one workspace, and return its mission_id. Steps are started only by mission_dispatch from this client: the bridge never runs a step by itself. The plan is append-only, so a retry is a new step rather than an edit. Validation is strict: unique step ids, existing dependencies, no cycles, one workspace, bridge limits.',
    inputSchema: missionCreateSchema, annotations: {readOnlyHint: false, idempotentHint: false, openWorldHint: false}
  }, async (input, ctx) => guard(async () => {
    const mission = await missions.create(input, {client: clientLabel(ctx.mcpReq.envelope)});
    return receipt(mission.mission_id);
  }));
  server.registerTool('mission_extend', {
    description: 'Append steps to an open mission. Existing steps are never modified: use this for corrections and follow-up work instead of re-dispatching a step that already ran.',
    inputSchema: missionExtendSchema, annotations: {readOnlyHint: false, idempotentHint: false, openWorldHint: false}
  }, async ({mission_id, steps}) => guard(async () => {
    await missions.extend(mission_id, steps);
    return receipt(mission_id);
  }));
  server.registerTool('mission_dispatch', {
    description: 'Start one ready step with the arguments recorded in its plan entry, as a normal supervised task. Refused while any dependency is not completed, if the step already has a task, or once the mission is canceled. Returns running with task_id: wait with antigravity_task_wait, then read mission_status. Completion still needs Tech Lead diff/test review, and a worktree branch is never merged automatically.',
    inputSchema: missionDispatchSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: true}
  }, async ({mission_id, step_id}, ctx) => guard(async () => {
    const {task} = await missions.dispatch(mission_id, step_id, {client: clientLabel(ctx.mcpReq.envelope)});
    return withStepNote({mission_id, step_id, task_id: task.task_id, status: task.status, duration_ms: task.duration_ms});
  }));
  server.registerTool('mission_status', {
    description: 'Mission progress: one short entry per step (state, task_id, dependencies and what blocks them, scope counts) with the step ids that are ready now. No task text or logs, so it is cheap to read after a reconnect or a restart. Does not start or cancel anything.',
    inputSchema: missionIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({mission_id}) => guard(() => {
    const view = missions.view(mission_id);
    return {...view, next_step: missionNote(view)};
  }));
  server.registerTool('mission_plan', {
    description: 'Full recorded plan: mission goal, requesting client and every step with its exact delegate arguments. Use it to recover the plan after losing context, instead of re-reading the repository.',
    inputSchema: missionIdSchema, annotations: {readOnlyHint: true, openWorldHint: false}
  }, async ({mission_id}) => guard(() => {
    const view = missions.view(mission_id);
    return {...missions.planOf(mission_id), next_step: missionNote(view)};
  }));
  server.registerTool('mission_cancel', {
    description: 'Cancel a mission so no further step can start. Tasks already running or queued are untouched unless cancel_running_tasks is true, because stopping an agent mid-edit is a separate decision; those task ids are returned. Partial file changes remain and nothing is rolled back.',
    inputSchema: missionCancelSchema, annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}
  }, async ({mission_id, cancel_running_tasks}) => guard(async () => {
    const {mission, running, canceled} = await missions.cancel(mission_id, {cancelRunningTasks: cancel_running_tasks === true});
    return {mission_id, status: mission.status, running_tasks: running, canceled_tasks: canceled, progress: missions.view(mission_id).progress};
  }));
  return server;
}
