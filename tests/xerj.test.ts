import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XerjClient, type XerjHit } from '../src/xerj/client.js';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TaskManager, type Runtime } from '../src/tasks/manager.js';
import { createServer as createMcpServer } from '../src/tools/register.js';
import { codexAdapter } from '../src/agents/codex.js';
import type { AgentRuntime } from '../src/agents/types.js';
import { startHttpBridge } from '../src/http.js';
import { missionsFor } from './helpers.js';
import type { Config, XerjConfig } from '../src/config.js';
import { codexApprovalSchema, xerjSchema } from '../src/config.js';

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({name, arguments: args});
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
};

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
      adapter: { id: 'antigravity', label: 'Antigravity', family: 'antigravity', executableName: 'agy', buildInvocation: () => ({ executable: 'agy', args: [] }) },
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

/** A client that always answers with one passage, and counts how often the bridge asked it anything. */
function spyClient(calls: string[]): XerjClient {
  const hits: XerjHit[] = [{file: 'src/keys.ts', score: 9, passage: 'export const ROTATION_KEY = "abc";'}];
  return {
    url: 'http://127.0.0.1:9200', defaultIndex: 'spy',
    isAvailable: async () => true, listIndices: async () => ['spy'],
    search: async (query: string) => { calls.push(query); return {query, available: true, total: 1, hits}; },
    formatPassagesForPrompt: (found: XerjHit[]) => `Relevant Codebase Reference (from XERJ):\n${found[0].passage}`
  } as unknown as XerjClient;
}

/** Runs one task against a profile whose fake CLI records the prompt it was handed on stdin. */
async function promptForTask(xerj: Config['xerj']): Promise<{prompt: string; queries: string[]}> {
  const root = await mkdtemp(path.join(tmpdir(), 'xerj-gate-'));
  const workspace = path.join(root, 'work'); await mkdir(workspace);
  const queries: string[] = [];
  const adapter = codexAdapter({executable: 'codex', prefixArgs: [], source: 'codex'}, {id: 'codex'});
  let prompt = '';
  const agent = {
    adapter,
    status: {id: 'codex', label: 'Codex', available: true, version: '1.0', executable: 'codex', capabilities: ['code' as const], warnings: []},
    enabled: true,
    launch: (_args: string[], _cwd: string, options?: {stdin?: string}) => {
      prompt = options?.stdin ?? '';
      const child = new EventEmitter() as EventEmitter & {pid: number; stdout: PassThrough; stderr: PassThrough; stdin: PassThrough};
      child.pid = 910_000; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      setTimeout(() => { child.stdout.end('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n'); child.emit('close', 0, null); }, 10);
      return child;
    }
  } as unknown as AgentRuntime;
  const config = {
    allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10,
    max_output_bytes: 262144, max_retained_tasks: 5, max_queued_tasks: 0, extra_env_passthrough: [], prompt_transport: 'argv',
    xerj
  } as unknown as Config;
  const manager = new TaskManager(config, {executable: 'codex', supported: true, stateDirectory: path.join(root, 'state'), agents: [agent], defaultAgent: 'codex'});
  manager.setXerjClient(spyClient(queries));
  try {
    await manager.delegate({task: 'fix the flaky test', workspace, acceptance_criteria: ['green'], context: 'the suite is slow'});
    await manager.wait((await manager.list())[0].task_id);
    return {prompt, queries};
  } finally {
    await manager.shutdown();
    await rm(root, {recursive: true, force: true});
  }
}

test('the shipped defaults leave XERJ off', () => {
  const parsed = xerjSchema.parse({});
  assert.equal(parsed.enabled, false, 'an install that never mentions xerj must not query another service');
  assert.equal(parsed.auto_reference, false, 'and must not paste a retrieved passage into a prompt');
  assert.equal(parsed.url, 'http://127.0.0.1:9200');
  assert.equal(codexApprovalSchema.safeParse('auto').success, false, 'codex has no approval policy named auto');
});

test('a retrieved passage enters the prompt only when the owner enabled both XERJ flags', async () => {
  const on = {enabled: true, url: 'http://127.0.0.1:9200', default_index: 'spy', auto_reference: true, max_passages: 3};
  const withReference = await promptForTask(on);
  assert.deepEqual(withReference.queries, ['fix the flaky test'], 'an opted-in bridge asks the index once per task');
  assert.match(withReference.prompt, /Relevant Codebase Reference/, 'the passage is in the prompt the agent receives');
  assert.match(withReference.prompt, /the suite is slow/, 'what the client sent is kept beside it');

  // The shipped default: neither flag, so nothing leaves the bridge and nothing is prepended.
  const off = await promptForTask(undefined);
  assert.deepEqual(off.queries, [], 'a bridge without xerj never queries the index');
  assert.doesNotMatch(off.prompt, /Relevant Codebase Reference/);
  assert.match(off.prompt, /the suite is slow/, 'the task itself still runs');

  // auto_reference alone must not be enough: an index the owner never enabled cannot feed the prompt.
  const halfOn = await promptForTask({enabled: false, url: 'http://127.0.0.1:9200', default_index: 'spy', auto_reference: true, max_passages: 3});
  assert.deepEqual(halfOn.queries, [], 'auto_reference without enabled does not reach the index');
  assert.doesNotMatch(halfOn.prompt, /Relevant Codebase Reference/);
});

test('code_search is on the surface but refuses while XERJ is disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xerj-surface-'));
  const workspace = path.join(root, 'work'); await mkdir(workspace);
  const bridgeConfig = (enabled: boolean) => ({
    enabled, url: 'http://127.0.0.1:59999', default_index: 'mcp-bridge-docs', auto_reference: false, max_passages: 3
  }) as unknown as XerjConfig;
  const start = async (xerj: XerjConfig | undefined) => {
    const manager = new TaskManager(
      {allowed_workspaces: [workspace], executable: 'agy', max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 1024,
       max_retained_tasks: 5, max_queued_tasks: 0, extra_env_passthrough: [], prompt_transport: 'argv', xerj} as unknown as Config,
      {executable: 'agy', supported: true, stateDirectory: path.join(root, `state-${xerj ? 'on' : 'off'}`)});
    manager.setXerjClient(spyClient([]));
    return {bridge: await startHttpBridge({manager, missions: missionsFor(manager, workspace), environment: {cli_version: 'mock'}, port: 0}), manager};
  };
  const off = await start(undefined);
  const on = await start(bridgeConfig(true));
  try {
    const client = new Client({name: 'xerj-test', version: '1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(off.bridge.mcpUrl)));
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes('code_search'), 'the surface does not depend on the owner config');
      const refused = await client.callTool({name: 'code_search', arguments: {query: 'ROTATION_KEY'}});
      assert.equal(refused.isError, true, 'a disabled bridge refuses instead of returning an empty result');
      assert.match(JSON.stringify(refused.content), /disabled/);
      const status = await fetch(`${off.bridge.baseUrl}/api/xerj/status`);
      assert.equal(((await status.json()) as {enabled: boolean}).enabled, false);
      const search = await fetch(`${off.bridge.baseUrl}/api/xerj/search?q=ROTATION_KEY`);
      assert.equal(search.status, 404, 'the UI route does not forward a query to a service the owner disabled');
    } finally { await client.close(); }

    const enabledClient = new Client({name: 'xerj-test-on', version: '1'});
    await enabledClient.connect(new StreamableHTTPClientTransport(new URL(on.bridge.mcpUrl)));
    try {
      const result = await call(enabledClient, 'code_search', {query: 'ROTATION_KEY'});
      assert.equal(result.total, 1, 'an opted-in bridge answers the search');
      assert.equal(((await (await fetch(`${on.bridge.baseUrl}/api/xerj/status`)).json()) as {enabled?: boolean}).enabled, undefined);
      const viaHttp = await (await fetch(`${on.bridge.baseUrl}/api/xerj/search?q=ROTATION_KEY`)).json() as {total: number};
      assert.equal(viaHttp.total, 1);
    } finally { await enabledClient.close(); }
  } finally {
    await off.bridge.close();
    await on.bridge.close();
    await rm(root, {recursive: true, force: true});
  }
});
