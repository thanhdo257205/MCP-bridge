import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { delegationControllable, delegationState, setDelegationSwitch } from '../delegation.js';
import { redact } from '../security/redact.js';
import type { TaskManager } from '../tasks/manager.js';
import { paths } from '../paths.js';
import { knownUpdate, readPackageInfo } from '../update.js';
import { workspaceChanges } from '../changes.js';
import { inside } from '../security/workspace.js';

export interface UiContext {
  manager: TaskManager; environment: Record<string, unknown>;
  mcpUrl: () => string; startedAt: number;
  requestShutdown?: () => Promise<void>;
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
    agents: env.agents ?? ctx.manager.agentsOverview().agents,
    default_agent: env.default_agent ?? ctx.manager.agentsOverview().default_agent,
    default_autonomy: env.default_autonomy ?? 'auto',
    concurrency: ctx.manager.overview().concurrency,
    limits: env.limits ?? {}, allowed_workspaces: env.allowed_workspaces ?? [], session_workspaces: env.session_workspaces ?? [], limitations: env.limitations ?? [],
    delegation: {...state, controllable: delegationControllable()},
    queue: ctx.manager.overview().queue,
    warnings: [await ctx.manager.lockDiagnostic()].filter(Boolean),
    update: knownUpdate() && {...knownUpdate(), package: readPackageInfo().name, command: 'agy-mcp-bridge update'},
    tasks: ctx.manager.list()
  };
}

let changesInFlight: Promise<unknown> | null = null;
/** Changes in a task's workspace, only while that directory is still allowed, and one scan at a time so repeated clicks cannot pile up git processes. */
async function changesFor(ctx: UiContext, id: string) {
  const task = ctx.manager.get(id);
  const unavailable = {available: false, reason: 'This task workspace is no longer readable under the bridge policy, so its files are not read.', head: null, changes: [], untracked: [], truncated: false};
  let target: string;
  if (task.worktree) {
    const [root, canonical] = await Promise.all([
      realpath(path.join(ctx.manager.stateDirectory, 'worktrees')).catch(() => null),
      realpath(task.worktree).catch(() => null)
    ]);
    if (!root || !canonical || !inside(root, canonical)) return {...unavailable, reason: 'This task worktree is outside the bridge state directory, so its files are not read.'};
    target = canonical;
  } else {
    const allowed = await Promise.all(((ctx.environment.allowed_workspaces as string[] | undefined) ?? []).map(root => realpath(root).catch(() => root)));
    const canonical = await realpath(task.workspace).catch(() => null);
    if (!canonical || !allowed.some(root => inside(root, canonical))) {
      return {...unavailable, reason: 'This workspace is no longer in the allowlist, so its files are not read.'};
    }
    target = canonical;
  }
  if (changesInFlight) return {available: false, reason: 'Another scan is still running; try again in a moment.', head: null, changes: [], untracked: [], truncated: false};
  const scan = workspaceChanges(target);
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

  try {
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
    if (pathname === '/ui/api/shutdown' && method === 'POST') {
      const body = await readJson(req);
      if (body.confirm !== true) { json(res, 400, {error: 'confirm must be true'}); return true; }
      if (!ctx.requestShutdown) { json(res, 503, {error: 'Shutdown is unavailable'}); return true; }
      const shutdown = ctx.requestShutdown;
      json(res, 202, {status: 'shutting_down'});
      // Let the response flush before the listener and owned processes are torn down.
      setTimeout(() => { void shutdown().catch(() => {}); }, 50);
      return true;
    }
    json(res, 404, {error: 'Not found'});
  } catch (error) {
    const message = error instanceof Error ? redact(error.message) : 'Request failed';
    json(res, /Unknown or expired/.test(message) ? 404 : 400, {error: message});
  }
  return true;
}
