import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const endpoint = process.env.BRIDGE_MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}/mcp`;
const client = new Client({name: 'bridge-check', version: '0.1.0'});
try {
  const token = process.env.BRIDGE_HTTP_TOKEN ?? (await readFile(fileURLToPath(new URL('../../.bridge-state/http-token', import.meta.url)), 'utf8')).trim();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {requestInit: {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(5000)}});
  await client.connect(transport);
  const result = await client.callTool({name: 'antigravity_environment', arguments: {}});
  if (result.isError) throw new Error('Tool failed');
  console.log(JSON.stringify(result.structuredContent, null, 2));
} catch {
  console.error(`[bridge-check] Cannot connect to ${endpoint}. Start the server with npm start; check URL/PORT and BRIDGE_HTTP_TOKEN, then reconnect.`);
  process.exitCode = 1;
} finally { await client.close(); }
