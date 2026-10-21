import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRuntime } from './runtime.js';
import { createServer } from './tools/register.js';

async function main() {
  const {manager, environment} = await createRuntime();
  const handle = serveStdio(() => createServer(manager, {...environment, transport: 'stdio'}), {onerror: () => console.error('[bridge] MCP transport error')});
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await manager.shutdown(); await handle.close(); }
    catch { console.error('[bridge] Shutdown failed; inspect managed processes and execution lock'); process.exitCode = 1; }
  };
  process.stdin.once('end', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  console.error('[bridge] stdio ready');
}
main().catch(() => { console.error('[bridge] Startup failed; check the configuration file'); process.exitCode = 1; });
