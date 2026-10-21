import path from 'node:path';
import { paths } from './paths.js';
import { checkForUpdate, knownUpdate, readPackageInfo, setKnownUpdate, updateCheckEnabled } from './update.js';
import { createRuntime } from './runtime.js';
import { configuredPort, startHttpBridge } from './http.js';
import { loadHttpToken } from './security/http-auth.js';

async function main() {
  const port = configuredPort();
  const {token, source} = await loadHttpToken(paths.stateDirectory);
  const {manager, environment} = await createRuntime();
  const bridge = await startHttpBridge({manager, environment, token, port});
  console.error(`[bridge] HTTP server: ${bridge.baseUrl}`);
  console.error(`[bridge] MCP endpoint: ${bridge.mcpUrl}`);
  console.error(`[bridge] Health check: ${bridge.healthUrl} (bearer authentication required)`);
  console.error(`[bridge] Token source: ${source} (value never logged)`);
  console.error('[bridge] Client disconnected: tasks continue. Ctrl+C: cancel owned tasks and stop server.');
  if (updateCheckEnabled(paths.mode)) {
    // Never blocks startup and never changes anything: it only lets the log and the web UI say that a newer version exists.
    const pkg = readPackageInfo();
    const look = async () => {
      const info = await checkForUpdate({stateDirectory: paths.stateDirectory, pkg});
      if (info && info.latest !== knownUpdate()?.latest) {
        console.error(`[bridge] Update available: ${pkg.name} ${info.latest} (running ${info.current}). Stop the server (Ctrl+C), then run: agy-mcp-bridge update`);
      }
      setKnownUpdate(info);
    };
    void look();
    setInterval(() => void look(), 6 * 60 * 60 * 1000).unref();
  }
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
  if (code === 'EADDRINUSE') console.error('[bridge] Port is already in use. Choose another: agy-mcp-bridge --port 3001 (or in PowerShell: $env:PORT="3001"; npm start)');
  else console.error('[bridge] Startup failed. Check PORT (0-65535), token configuration and workspace config JSON.');
  process.exitCode = 1;
});
