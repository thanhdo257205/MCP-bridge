import path from 'node:path';
import { projectRoot } from './config.js';
import { createRuntime } from './runtime.js';
import { configuredPort, startHttpBridge } from './http.js';
import { loadHttpToken } from './security/http-auth.js';

async function main() {
  const port = configuredPort();
  const {token, source} = await loadHttpToken(path.join(projectRoot, '.bridge-state'));
  const {manager, environment} = await createRuntime();
  const bridge = await startHttpBridge({manager, environment, token, port});
  console.error(`[bridge] HTTP server: ${bridge.baseUrl}`);
  console.error(`[bridge] MCP endpoint: ${bridge.mcpUrl}`);
  console.error(`[bridge] Health check: ${bridge.healthUrl} (bearer authentication required)`);
  console.error(`[bridge] Token source: ${source} (value never logged)`);
  console.error('[bridge] Client disconnected: tasks continue. Ctrl+C: cancel owned tasks and stop server.');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.error('[bridge] Shutting down; no new tasks accepted');
    try { await bridge.close(); console.error('[bridge] Stopped'); }
    catch { console.error('[bridge] Cleanup failed; inspect owned processes and execution lock'); process.exitCode = 1; }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  bridge.server.on('error', () => { console.error('[bridge] Fatal HTTP listener error'); process.exitCode = 1; void shutdown(); });
}
main().catch(error => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') console.error('[bridge] Port is already in use. In PowerShell choose another: $env:PORT="3001"; npm start');
  else console.error('[bridge] Startup failed. Check PORT (0-65535), token configuration and workspace config JSON.');
  process.exitCode = 1;
});
