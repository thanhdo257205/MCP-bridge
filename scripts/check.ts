import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.BRIDGE_MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/mcp`;
const client = new Client({name: 'bridge-check', version: '0.1.0'});
try {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {requestInit: {signal: AbortSignal.timeout(5000)}});
  await client.connect(transport);
  const result = await client.callTool({name: 'antigravity_environment', arguments: {}});
  if (result.isError) throw new Error('Tool failed');
  console.log(JSON.stringify(result.structuredContent, null, 2));
} catch {
  console.error(`[bridge-check] Cannot connect to ${endpoint}. Start the server (npm start, or agy-mcp-bridge when installed from npm); check the URL/PORT, then reconnect.`);
  process.exitCode = 1;
} finally { await client.close(); }
