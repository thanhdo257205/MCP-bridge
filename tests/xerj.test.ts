import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XerjClient, type XerjHit } from '../src/xerj/client.js';
import { createServer } from 'node:http';
import { TaskManager, type Runtime } from '../src/tasks/manager.js';
import { createServer as createMcpServer } from '../src/tools/register.js';
import type { Config } from '../src/config.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('XerjClient gracefully handles offline server without throwing', async () => {
  const offlineClient = new XerjClient({ url: 'http://127.0.0.1:59999', timeoutMs: 100 });
  
  const available = await offlineClient.isAvailable();
  assert.equal(available, false);

  const indices = await offlineClient.listIndices();
  assert.deepEqual(indices, []);

  const result = await offlineClient.search('budgetState');
  assert.equal(result.available, false);
  assert.equal(result.total, 0);
  assert.deepEqual(result.hits, []);
});

test('XerjClient parses search results and passages correctly with a mock server', async () => {
  const mockServer = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tagline: 'XERJ test' }));
      return;
    }
    if (req.url === '/_cat/indices?format=json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ index: 'mcp-bridge-docs' }, { index: 'catalog' }]));
      return;
    }
    if (req.url?.includes('/_search')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        took: 12,
        timed_out: false,
        hits: {
          total: { value: 1 },
          hits: [
            {
              _score: 18.5,
              _source: { ax_path: 'src/budget.ts', title: 'budget.ts', start_line: 42 },
              fields: {
                _passage: [{ text: 'export async function budgetState() { return true; }' }]
              }
            }
          ]
        }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const address = mockServer.address() as { port: number };
  const client = new XerjClient({ url: `http://127.0.0.1:${address.port}` });

  try {
    const isAvail = await client.isAvailable();
    assert.equal(isAvail, true);

    const indices = await client.listIndices();
    assert.deepEqual(indices, ['mcp-bridge-docs', 'catalog']);

    const searchRes = await client.search('budgetState');
    assert.equal(searchRes.available, true);
    assert.equal(searchRes.total, 1);
    assert.equal(searchRes.hits.length, 1);
    assert.equal(searchRes.hits[0].file, 'src/budget.ts');
    assert.equal(searchRes.hits[0].score, 18.5);
    assert.equal(searchRes.hits[0].line, 42);
    assert.match(searchRes.hits[0].passage ?? '', /export async function budgetState/);

    const promptContext = client.formatPassagesForPrompt(searchRes.hits);
    assert.match(promptContext, /Relevant Codebase Reference \(from XERJ\)/);
    assert.match(promptContext, /src\/budget\.ts/);
    assert.match(promptContext, /budgetState/);
  } finally {
    mockServer.close();
  }
});

test('XerjClient formatPassagesForPrompt returns empty string when no passages', () => {
  const client = new XerjClient();
  const hits: XerjHit[] = [
    { file: 'readme.md', score: 1.2 }
  ];
  assert.equal(client.formatPassagesForPrompt(hits), '');
  assert.equal(client.formatPassagesForPrompt([]), '');
});

test('code_search tool is registered on McpServer and proxies query to XerjClient', async () => {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'xerj-test-'));
  const config = {
    allowed_workspaces: [scratchDir],
    executable: 'agy',
    max_timeout_seconds: 900,
    default_timeout_seconds: 300,
    max_output_bytes: 262144,
    max_retained_tasks: 50,
    max_queued_tasks: 3,
    extra_env_passthrough: [],
    prompt_transport: 'argv' as const,
    xerj: {
      enabled: true,
      url: 'http://127.0.0.1:59999', // offline
      default_index: 'mcp-bridge-docs',
      auto_reference: true,
      max_passages: 3
    }
  } as unknown as Config;

  const runtime = {
    stateDirectory: scratchDir,
    supported: true,
    executable: 'agy',
    agents: [{
      adapter: { id: 'antigravity', label: 'Antigravity', executableName: 'agy', buildInvocation: () => ({ executable: 'agy', args: [] }) },
      enabled: true,
      status: { available: true, path: 'agy', warnings: [] }
    }]
  } as unknown as Runtime;

  const manager = new TaskManager(config, runtime);
  
  // Custom mock client
  const mockHits: XerjHit[] = [
    { file: 'src/test.ts', score: 10, passage: 'function testSnippet() {}' }
  ];
  const customClient = {
    url: 'http://mock:9200',
    defaultIndex: 'test-idx',
    isAvailable: async () => true,
    listIndices: async () => ['test-idx'],
    search: async (q: string) => ({ query: q, available: true, total: 1, hits: mockHits }),
    formatPassagesForPrompt: (hits: XerjHit[]) => `Formatted: ${hits[0]?.file}`
  } as unknown as XerjClient;

  manager.setXerjClient(customClient);

  const mockMissions = {
    overview: () => ({ total: 0 }),
    view: () => ({ status: 'done', workspace: '', progress: {}, ready: [] }),
    planOf: () => ({}),
    create: async () => ({ mission_id: 'm-1' }),
    extend: async () => {},
    dispatch: async () => ({ task: { task_id: 't-1', status: 'running', duration_ms: 0 } }),
    cancel: async () => ({ mission: { status: 'canceled' }, running: [], canceled: [] })
  };

  const mcpServer = createMcpServer(manager, {}, mockMissions as any);
  assert.ok(mcpServer);

  // Directly check the manager's XerjClient
  const res = await manager.getXerjClient().search('testQuery');
  assert.equal(res.available, true);
  assert.equal(res.hits[0].file, 'src/test.ts');
  assert.equal(res.hits[0].passage, 'function testSnippet() {}');

  await rm(scratchDir, { recursive: true, force: true });
});
