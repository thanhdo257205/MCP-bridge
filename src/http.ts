import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer } from './tools/register.js';
import { authorized, validateToken } from './security/http-auth.js';
import { registerSecret } from './security/redact.js';
import type { TaskManager } from './tasks/manager.js';

export const DEFAULT_PORT = 3000;
export function configuredPort(value = process.env.PORT): number {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('PORT must be an integer from 0 to 65535 (0 chooses an available port)');
  return Number(value);
}

export async function startHttpBridge(options: {
  manager: TaskManager; environment: Record<string, unknown>; token: string; port: number;
}) {
  validateToken(options.token);
  registerSecret(options.token);
  let stopping = false;
  let baseUrl = '';
  const handler = createMcpHandler(() => createServer(options.manager, options.environment), {maxRequestBodySize: 131072, maxSubscriptions: 16});
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
    if (!authorized(req.headers.authorization, options.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="antigravity-bridge"');
      reply(401, {error: 'Missing or invalid bearer token. Load the bridge token into BRIDGE_HTTP_TOKEN in the client terminal.'}); return;
    }
    if (stopping) { reply(503, {error: 'Bridge is shutting down. Restart with npm start before reconnecting.'}); return; }
    if (req.url === '/health' && req.method === 'GET') {
      reply(200, {status: 'ok', transport: 'streamable-http', mcp_endpoint: `${baseUrl}/mcp`, ...options.manager.overview()}); return;
    }
    if (req.url !== '/mcp') { reply(404, {error: 'Use /mcp for MCP or GET /health for health checks'}); return; }
    void mcp(req, res).catch(() => {
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
  return {baseUrl, mcpUrl: `${baseUrl}/mcp`, healthUrl: `${baseUrl}/health`, close, server};
}
