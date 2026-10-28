import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer } from './tools/register.js';
import type { TaskManager } from './tasks/manager.js';
import type { MissionManager } from './missions/missions.js';
import { requestContext } from './request-context.js';
import { handleUi } from './ui/routes.js';

export const DEFAULT_PORT = 3000;
export function configuredPort(value = process.env.PORT): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('PORT must be an integer from 0 to 65535 (0 chooses an available port)');
  return Number(value);
}

export async function startHttpBridge(options: {
  manager: TaskManager; missions: MissionManager; environment: Record<string, unknown>; port: number;
  requestShutdown?: () => Promise<void>;
}) {
  let stopping = false;
  let baseUrl = '';
  const ui = {manager: options.manager, missions: options.missions, environment: options.environment, mcpUrl: () => `${baseUrl}/mcp`, startedAt: Date.now(), requestShutdown: options.requestShutdown};
  const handler = createMcpHandler(() => createServer(options.manager, options.environment, options.missions), {maxRequestBodySize: 131072, maxSubscriptions: 16});
  const mcp = toNodeHandler(handler, {maxRequestBodySize: 131072});
  const server = createHttpServer((req, res) => {
    const reply = (code: number, body: Record<string, unknown>) => {
      res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      res.end(JSON.stringify(body));
    };
    // Do not trust proxy headers. Reject DNS rebinding and unsolicited browser origins.
    if (req.headers.host !== new URL(baseUrl).host || (req.headers.origin !== undefined && req.headers.origin !== baseUrl)) {
      reply(403, {error: 'Host or Origin is not allowed'}); return;
    }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(302, {Location: '/ui', 'Cache-Control': 'no-store'}); res.end(); return; }
    if (req.url === '/ui' || req.url?.startsWith('/ui/')) {
      if (stopping) { reply(503, {error: 'Bridge is shutting down.'}); return; }
      void handleUi(req, res, ui).catch(() => { if (!res.headersSent) reply(500, {error: 'UI request failed'}); else res.destroy(); });
      return;
    }
    if (stopping) { reply(503, {error: 'Bridge is shutting down. Restart it (agy-mcp-bridge, or npm start in a git checkout) before reconnecting.'}); return; }
    if (req.url === '/health' && req.method === 'GET') {
      reply(200, {status: 'ok', transport: 'streamable-http', mcp_endpoint: `${baseUrl}/mcp`, ...options.manager.overview(), missions: options.missions.overview()}); return;
    }
    if (req.url === '/api/xerj/status' && req.method === 'GET') {
      const xerj = options.manager.getXerjClient();
      if (!options.manager.isXerjEnabled()) {
        reply(200, {enabled: false, available: false, url: xerj.url, default_index: xerj.defaultIndex, indices: []});
        return;
      }
      void xerj.isAvailable().then(async available => {
        const indices = available ? await xerj.listIndices() : [];
        reply(200, {available, url: xerj.url, default_index: xerj.defaultIndex, indices});
      }).catch(() => reply(200, {available: false, url: xerj.url, default_index: xerj.defaultIndex, indices: []}));
      return;
    }
    if (req.url?.startsWith('/api/xerj/search') && req.method === 'GET') {
      if (!options.manager.isXerjEnabled()) {
        reply(404, {error: 'XERJ search is disabled: set "xerj.enabled" to true in workspaces.json'});
        return;
      }
      const parsed = new URL(req.url, baseUrl || 'http://127.0.0.1:3000');
      const q = parsed.searchParams.get('q') ?? '';
      const limit = parseInt(parsed.searchParams.get('limit') ?? '5', 10);
      const index = parsed.searchParams.get('index') ?? undefined;
      const xerj = options.manager.getXerjClient();
      void xerj.search(q, {limit, index}).then(result => reply(200, result as unknown as Record<string, unknown>)).catch(() => reply(500, {error: 'Search failed'}));
      return;
    }
    if (req.url !== '/mcp') { reply(404, {error: 'Use /mcp for MCP or GET /health for health checks'}); return; }
    void requestContext.run({userAgent: req.headers['user-agent']}, () => mcp(req, res)).catch(() => {
      if (!res.headersSent) reply(500, {error: 'MCP request failed'});
      else res.destroy();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListen);
    server.listen(options.port, '127.0.0.1');
  }).catch(async error => { await handler.close(); throw error; });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    stopping = true;
    options.manager.stopAccepting();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    closing = (async () => {
      try { await options.manager.shutdown(); }
      finally {
        const force = setTimeout(() => server.closeAllConnections(), 3000);
        try { await handler.close(); server.closeIdleConnections(); await closed; }
        finally { clearTimeout(force); }
      }
    })();
    return closing;
  };
  ui.requestShutdown ??= close;
  return {baseUrl, mcpUrl: `${baseUrl}/mcp`, healthUrl: `${baseUrl}/health`, close, server};
}
