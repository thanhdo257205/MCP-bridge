import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAgent } from '../src/agents/codex.js';
import type { AgentStatus } from '../src/agents/types.js';
import type { Config } from '../src/config.js';
import { eventOf, notificationBody, notifySchema, notifyTaskEnd, type NotifySubject } from '../src/notify.js';
import { TaskManager } from '../src/tasks/manager.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-codex.mjs', import.meta.url));
const status: AgentStatus = {id: 'codex', label: 'Codex', available: true, version: 'fake', executable: 'fixture', capabilities: ['code'], warnings: []};
const subject = (extra: Partial<NotifySubject> = {}): NotifySubject => ({
  task_id: '6a1610a1-12bb-46d1-87b2-6e5e73219801', status: 'completed', agent: 'codex', workspace: '/home/me/projects/shop',
  duration_ms: 134_000, error: null, denied_actions: [], cli_status: null, ...extra
});

async function receiver() {
  const received: {type: string | undefined; body: string}[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({type: req.headers['content-type'], body}); res.writeHead(req.url === '/refuse' ? 500 : 200); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {url, received, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

test('the notify config is the owner\'s: http(s) only, sensible default events, nothing about the task unless asked', () => {
  const parsed = notifySchema.parse({url: 'https://ntfy.sh/my-topic'});
  assert.deepEqual(parsed, {url: 'https://ntfy.sh/my-topic', events: ['completed', 'failed', 'timeout', 'denied', 'quota'], format: 'json', include_title: false});
  for (const url of ['file:///etc/passwd', 'ftp://x', 'not a url', 'javascript:alert(1)']) assert.throws(() => notifySchema.parse({url}), url);
  assert.throws(() => notifySchema.parse({url: 'https://x', events: ['done']}));
  assert.throws(() => notifySchema.parse({url: 'https://x', headers: {Authorization: 'x'}}), 'no field can carry a secret');
});

test('a refusal and an exhausted quota are reported as such, not as plain failures', () => {
  assert.equal(eventOf(subject()), 'completed');
  assert.equal(eventOf(subject({status: 'failed', denied_actions: [{}]})), 'denied');
  assert.equal(eventOf(subject({status: 'failed', cli_status: 'quota_exceeded'})), 'quota');
  assert.equal(eventOf(subject({status: 'timeout'})), 'timeout');
  assert.equal(eventOf(subject({status: 'running'})), null);
});

test('the message carries the project name, not the path, and no task text unless include_title', () => {
  const config = notifySchema.parse({url: 'https://x', format: 'text'});
  const text = notificationBody(config, subject({status: 'failed', error: 'Codex exited 3'}), 'failed', 'Fix the login bug');
  assert.equal(text.body, '[bridge] codex failed · shop · 2m14s · 6a1610a1\nCodex exited 3');
  assert.doesNotMatch(text.body, /home\/me|login bug/);
  const titled = notificationBody({...config, include_title: true}, subject(), 'completed', 'Fix the login bug with api_key=sk-abcdefghijklmnopqrstuvwxyz123456');
  assert.match(titled.body, /Fix the login bug/);
  assert.doesNotMatch(titled.body, /sk-abcdefghijklmnopqrstuvwxyz123456/, 'secrets are filtered as in task logs');
  const json = JSON.parse(notificationBody(notifySchema.parse({url: 'https://x'}), subject(), 'completed', 'x').body);
  assert.deepEqual(json, {source: 'agy-mcp-bridge', event: 'completed', task_id: subject().task_id, status: 'completed', agent: 'codex', project: 'shop', duration_ms: 134000, denied_actions: 0});
});

test('a send that fails or is refused is reported and never throws; an event not asked for is not sent', async () => {
  const sink = await receiver();
  try {
    assert.equal(await notifyTaskEnd(notifySchema.parse({url: `${sink.url}/refuse`}), subject(), null), false);
    assert.equal(await notifyTaskEnd(notifySchema.parse({url: 'http://127.0.0.1:1/nothing-listens'}), subject(), null), false);
    assert.equal(await notifyTaskEnd(notifySchema.parse({url: sink.url, events: ['failed']}), subject(), null), false);
    assert.equal(sink.received.length, 1, 'only the refused send reached the server');
    assert.equal(await notifyTaskEnd(undefined, subject(), null), false);
  } finally { await sink.close(); }
});

test('the bridge notifies once per finished task, after its final status, including a failover-free failure', async () => {
  const sink = await receiver();
  const root = await mkdtemp(path.join(tmpdir(), 'agy-notify-'));
  const workspace = path.join(root, 'shop'); await mkdir(workspace);
  const config: Config = {
    allowed_workspaces: [workspace], executable: process.execPath, max_timeout_seconds: 15, default_timeout_seconds: 10, max_output_bytes: 262144,
    max_retained_tasks: 10, max_queued_tasks: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport: 'argv',
    notify: notifySchema.parse({url: sink.url, events: ['completed', 'failed', 'denied']})
  };
  const make = (scenario: string) => codexAgent({executable: process.execPath, prefixArgs: [fixture, scenario], source: 'fixture'}, status);
  for (const [scenario, event] of [['ok', 'completed'], ['fail', 'failed'], ['denied', 'denied']] as const) {
    const manager = new TaskManager(config, {executable: process.execPath, supported: true, stateDirectory: path.join(root, `state-${scenario}`), agents: [make(scenario)], defaultAgent: 'codex'});
    const done = await manager.wait((await manager.delegate({task: 'Do the thing\nsecond line', workspace, acceptance_criteria: ['ok'], agent: 'codex'})).task_id);
    await manager.shutdown(); // waits for the detached send
    const last = JSON.parse(sink.received.at(-1)!.body);
    assert.equal(last.event, event, scenario);
    assert.equal(last.task_id, done.task_id);
    assert.equal(last.status, done.status);
    assert.equal(last.project, 'shop');
    assert.equal(last.title, undefined);
  }
  assert.equal(sink.received.length, 3);
  await sink.close();
  await rm(root, {recursive: true, force: true});
});
