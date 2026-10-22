import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { delegationControllable, delegationState, setDelegationSwitch } from '../delegation.js';
import { tokensEqual } from '../security/http-auth.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';
import { SessionStore } from './session.js';
import { paths } from '../paths.js';
import { knownUpdate, readPackageInfo } from '../update.js';
import { workspaceChanges } from '../changes.js';
import { validModelId, writeModel } from '../models.js';
import { EFFORT_LEVELS, isEffortLevel, readEffort, writeEffort } from '../effort.js';
import { MAX_ABSOLUTE_LIMIT_SECONDS, MIN_ABSOLUTE_LIMIT_SECONDS, isAbsoluteLimit, readSoftTimeout, writeSoftTimeout } from '../soft-timeout.js';
import { MAX_SETTING_WAIT_SECONDS, MIN_WAIT_SECONDS, clientToolTimeoutSeconds, isWaitSeconds, writeWait } from '../wait-setting.js';
import { PERMISSION_LEVELS, isPermissionLevel, needsAcknowledgement, permissionState, writePermission } from '../permissions.js';
import { inside } from '../security/workspace.js';

export interface UiContext {
  manager: TaskManager; environment: Record<string, unknown>; token: string;
  mcpUrl: () => string; startedAt: number; sessions: SessionStore;
}

const assets: Record<string, {file: string; type: string}> = {
  '/ui': {file: 'index.html', type: 'text/html; charset=utf-8'},
  '/ui/': {file: 'index.html', type: 'text/html; charset=utf-8'},
  '/ui/app.css': {file: 'app.css', type: 'text/css; charset=utf-8'},
  '/ui/app.js': {file: 'app.js', type: 'text/javascript; charset=utf-8'},
  '/ui/favicon.svg': {file: 'favicon.svg', type: 'image/svg+xml'}
};
const uiDirectory = paths.uiDirectory;
// No inline script or style, no external origin: model output shown in the page can never execute.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function send(res: ServerResponse, code: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra});
  res.end(body);
}
const json = (res: ServerResponse, code: number, value: unknown) => send(res, code, JSON.stringify(value), 'application/json');

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

async function overview(ctx: UiContext) {
  const env = ctx.environment as Record<string, unknown>;
  const state = delegationState(ctx.manager.stateDirectory);
  return {
    server: {
      version: readPackageInfo().version, started_at: new Date(ctx.startedAt).toISOString(), uptime_seconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      mcp_endpoint: ctx.mcpUrl(), accepting_tasks: ctx.manager.overview().accepting_tasks
    },
    cli: {
      version: env.cli_version, executable: env.executable, bridge_status: env.bridge_status,
      execution_method: env.execution_method, authentication: env.authentication
    },
    limits: env.limits ?? {}, allowed_workspaces: env.allowed_workspaces ?? [], session_workspaces: env.session_workspaces ?? [], limitations: env.limitations ?? [],
    delegation: {...state, controllable: delegationControllable()},
    model: await ctx.manager.currentModel(),
    permission: permissionState(ctx.manager.stateDirectory),
    effort: readEffort(ctx.manager.stateDirectory),
    soft_timeout: readSoftTimeout(ctx.manager.stateDirectory),
    wait: {seconds: ctx.manager.maxWaitSeconds, client_tool_timeout_seconds: clientToolTimeoutSeconds(ctx.manager.maxWaitSeconds)},
    queue: ctx.manager.overview().queue,
    warnings: [await ctx.manager.lockDiagnostic()].filter(Boolean),
    update: knownUpdate() && {...knownUpdate(), package: readPackageInfo().name, command: 'agy-mcp-bridge update'},
    tasks: ctx.manager.list()
  };
}

let changesInFlight: Promise<unknown> | null = null;
/** Changes in a task's workspace, only while that directory is still allowed, and one scan at a time so repeated clicks cannot pile up git processes. */
async function changesFor(ctx: UiContext, id: string) {
  const {workspace} = ctx.manager.get(id);
  const allowed = await Promise.all(((ctx.environment.allowed_workspaces as string[] | undefined) ?? []).map(root => realpath(root).catch(() => root)));
  const canonical = await realpath(workspace).catch(() => null);
  if (!canonical || !allowed.some(root => inside(root, canonical))) {
    return {available: false, reason: 'This workspace is no longer in the allowlist, so its files are not read.', head: null, changes: [], untracked: [], truncated: false};
  }
  if (changesInFlight) return {available: false, reason: 'Another scan is still running; try again in a moment.', head: null, changes: [], untracked: [], truncated: false};
  const scan = workspaceChanges(canonical);
  changesInFlight = scan;
  try { return await scan; } finally { changesInFlight = null; }
}

/** Handles /ui and /ui/api/*. Returns false for any other path. Host/Origin checks happen before this is called. */
export async function handleUi(req: IncomingMessage, res: ServerResponse, ctx: UiContext): Promise<boolean> {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false;
  const method = req.method ?? 'GET';
  const asset = assets[pathname];
  if (asset) {
    if (method !== 'GET') { json(res, 405, {error: 'Method not allowed'}); return true; }
    try {
      const headers: Record<string, string> = pathname.endsWith('/') || pathname === '/ui' ? {'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY'} : {};
      send(res, 200, await readFile(path.join(uiDirectory, asset.file)), asset.type, headers);
    } catch { json(res, 500, {error: 'UI asset unavailable'}); }
    return true;
  }
  if (!pathname.startsWith('/ui/api/')) { json(res, 404, {error: 'Not found'}); return true; }

  const session = req.headers['x-bridge-session'];
  const sessionId = typeof session === 'string' ? session : undefined;
  try {
    if (pathname === '/ui/api/login' && method === 'POST') {
      if (ctx.sessions.throttled()) { json(res, 429, {error: 'Too many failed attempts. Wait a minute and try again.'}); return true; }
      const body = await readJson(req);
      if (typeof body.token !== 'string' || !tokensEqual(body.token.trim(), ctx.token)) {
        ctx.sessions.recordFailure(); json(res, 401, {error: 'Invalid token'}); return true;
      }
      json(res, 200, {session: ctx.sessions.create()}); return true;
    }
    if (!ctx.sessions.valid(sessionId)) { json(res, 401, {error: 'Sign in with the bridge token'}); return true; }
    if (pathname === '/ui/api/logout' && method === 'POST') { ctx.sessions.destroy(sessionId); json(res, 200, {ok: true}); return true; }
    if (pathname === '/ui/api/overview' && method === 'GET') { json(res, 200, await overview(ctx)); return true; }
    const detail = pathname.match(new RegExp(`^/ui/api/tasks/(${UUID})$`));
    if (detail && method === 'GET') { json(res, 200, ctx.manager.detail(detail[1])); return true; }
    const changes = pathname.match(new RegExp(`^/ui/api/tasks/(${UUID})/changes$`));
    if (changes && method === 'GET') { json(res, 200, await changesFor(ctx, changes[1])); return true; }
    const cancel = pathname.match(new RegExp(`^/ui/api/tasks/(${UUID})/cancel$`));
    if (cancel && method === 'POST') { await ctx.manager.cancel(cancel[1]); json(res, 200, ctx.manager.detail(cancel[1])); return true; }
    if (pathname === '/ui/api/delegation' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') { json(res, 400, {error: 'enabled must be true or false'}); return true; }
      if (!delegationControllable()) { json(res, 409, {error: 'Delegation is locked by BRIDGE_DELEGATION in the server environment'}); return true; }
      await setDelegationSwitch(ctx.manager.stateDirectory, body.enabled);
      json(res, 200, {...delegationState(ctx.manager.stateDirectory), controllable: true}); return true;
    }
    if (pathname === '/ui/api/soft-timeout' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') { json(res, 400, {error: 'enabled must be true or false'}); return true; }
      const current = readSoftTimeout(ctx.manager.stateDirectory);
      const limit = body.limit_seconds === undefined ? current.limit_seconds : body.limit_seconds;
      if (body.limit_seconds !== undefined && !isAbsoluteLimit(body.limit_seconds)) { json(res, 400, {error: `limit_seconds must be a whole number from ${MIN_ABSOLUTE_LIMIT_SECONDS} to ${MAX_ABSOLUTE_LIMIT_SECONDS}`}); return true; }
      await writeSoftTimeout(ctx.manager.stateDirectory, {enabled: body.enabled, limit_seconds: limit as number});
      json(res, 200, readSoftTimeout(ctx.manager.stateDirectory)); return true;
    }
    if (pathname === '/ui/api/wait' && method === 'POST') {
      const body = await readJson(req);
      if (body.seconds !== null && !isWaitSeconds(body.seconds)) { json(res, 400, {error: `seconds must be a whole number from ${MIN_WAIT_SECONDS} to ${MAX_SETTING_WAIT_SECONDS}, or null for the default`}); return true; }
      await writeWait(ctx.manager.stateDirectory, body.seconds as number | null);
      json(res, 200, {seconds: ctx.manager.maxWaitSeconds, client_tool_timeout_seconds: clientToolTimeoutSeconds(ctx.manager.maxWaitSeconds)}); return true;
    }
    if (pathname === '/ui/api/effort' && method === 'POST') {
      const body = await readJson(req);
      if (!isEffortLevel(body.effort)) { json(res, 400, {error: `effort must be one of: ${EFFORT_LEVELS.join(', ')}`}); return true; }
      await writeEffort(ctx.manager.stateDirectory, body.effort);
      json(res, 200, {effort: body.effort}); return true;
    }
    if (pathname === '/ui/api/permission' && method === 'POST') {
      const body = await readJson(req);
      if (!isPermissionLevel(body.level)) { json(res, 400, {error: `level must be one of: ${PERMISSION_LEVELS.join(', ')}`}); return true; }
      if (!permissionState(ctx.manager.stateDirectory).controllable) { json(res, 409, {error: 'The permission level is locked by BRIDGE_AGY_PERMISSIONS in the server environment'}); return true; }
      if (needsAcknowledgement(body.level) && body.acknowledge_risk !== true) { json(res, 400, {error: 'This level lets Antigravity act without asking; send acknowledge_risk: true to confirm'}); return true; }
      await writePermission(ctx.manager.stateDirectory, body.level);
      json(res, 200, permissionState(ctx.manager.stateDirectory)); return true;
    }
    if (pathname === '/ui/api/models' && method === 'GET') {
      const current = await ctx.manager.currentModel();
      try { json(res, 200, {models: await ctx.manager.availableModels(), current}); }
      catch (error) { json(res, 200, {models: [], current, error: error instanceof Error ? redact(error.message) : 'Could not list models'}); }
      return true;
    }
    if (pathname === '/ui/api/model' && method === 'POST') {
      const body = await readJson(req);
      if (body.model !== null && !validModelId(body.model)) { json(res, 400, {error: 'model must be a model id or null'}); return true; }
      // Only ids that `agy models` lists are accepted; if the list cannot be read, the choice cannot be verified, so it is refused.
      if (body.model !== null) {
        const listed = await ctx.manager.availableModels().catch(() => null);
        if (!listed) { json(res, 409, {error: 'Cannot verify the model: `agy models` is not available'}); return true; }
        if (!listed.some(model => model.id === body.model)) { json(res, 400, {error: 'Unknown model; choose one listed by `agy models`'}); return true; }
      }
      await writeModel(ctx.manager.stateDirectory, body.model);
      json(res, 200, {current: body.model}); return true;
    }
    json(res, 404, {error: 'Not found'});
  } catch (error) {
    const message = error instanceof Error ? redact(error.message) : 'Request failed';
    json(res, /Unknown or expired/.test(message) ? 404 : 400, {error: message});
  }
  return true;
}
