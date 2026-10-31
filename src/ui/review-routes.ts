import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UiContext } from './routes.js';

/**
 * The owner's approval queue over HTTP (docs/APPROVAL-QUEUE-PLAN.md). Only the web UI can reach it: there is deliberately no MCP tool to read the
 * queue, approve, or raise a permission, so an agent or a client cannot approve what its own run was refused. Every change needs `confirm: true`.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'});
  res.end(JSON.stringify(value));
}

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

/** Returns true when it answered the request. Errors are thrown to the caller, which turns them into a 400 (404 for an unknown task). */
export async function handleReviewRoutes(req: IncomingMessage, res: ServerResponse, ctx: UiContext, pathname: string, method: string): Promise<boolean> {
  if (pathname === '/ui/api/approvals' && method === 'GET') { json(res, 200, {approvals: ctx.manager.approvals()}); return true; }

  const approve = pathname.match(new RegExp(`^/ui/api/tasks/(${UUID})/approve$`));
  if (approve && method === 'POST') {
    const body = await readJson(req);
    if (body.confirm !== true) { json(res, 400, {error: 'confirm must be true'}); return true; }
    const result = await ctx.manager.approveTask(approve[1], body.elevation);
    json(res, 200, {rerun_of: result.rerun_of, task: ctx.manager.summary(result.task.task_id)}); return true;
  }

  const dismiss = pathname.match(new RegExp(`^/ui/api/tasks/(${UUID})/dismiss$`));
  if (dismiss && method === 'POST') {
    const body = await readJson(req);
    if (body.confirm !== true) { json(res, 400, {error: 'confirm must be true'}); return true; }
    json(res, 200, {task: await ctx.manager.dismissApproval(dismiss[1])}); return true;
  }
  return false;
}
