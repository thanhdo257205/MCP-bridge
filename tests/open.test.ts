import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { browserCommand, openBrowser } from '../src/open.js';

const url = 'http://127.0.0.1:3000/ui';
const fake = (event: 'spawn' | 'error') => {
  const calls: {command: string; args: string[]}[] = [];
  const impl = ((command: string, args: string[]) => {
    calls.push({command, args});
    const child = new EventEmitter() as ChildProcess; (child as unknown as {unref: () => void}).unref = () => undefined;
    queueMicrotask(() => child.emit(event, event === 'error' ? new Error('ENOENT') : undefined));
    return child;
  }) as never;
  return {calls, impl};
};

test('open: the right opener per platform, with the URL as a single argument and no shell', () => {
  assert.deepEqual(browserCommand('win32', url), {command: 'rundll32', args: ['url.dll,FileProtocolHandler', url]});
  assert.deepEqual(browserCommand('darwin', url), {command: 'open', args: [url]});
  assert.deepEqual(browserCommand('linux', url), {command: 'xdg-open', args: [url]});
});
test('open: succeeds when the opener starts, reports false when it is missing', async () => {
  const ok = fake('spawn');
  assert.equal(await openBrowser(url, {platform: 'linux', spawnImpl: ok.impl}), true);
  assert.deepEqual(ok.calls, [{command: 'xdg-open', args: [url]}]);
  assert.equal(await openBrowser(url, {platform: 'linux', spawnImpl: fake('error').impl}), false);
});
test('open: only the local web UI URL is ever passed to the opener', async () => {
  const f = fake('spawn');
  for (const bad of ['http://evil.example/ui', 'https://127.0.0.1:3000/ui', 'http://127.0.0.1:3000/ui?x=1', 'http://127.0.0.1:3000/mcp', 'file:///etc/passwd', 'http://127.0.0.1:3000/ui" & calc', 'calc.exe']) {
    assert.equal(await openBrowser(bad, {platform: 'win32', spawnImpl: f.impl}), false, bad);
  }
  assert.equal(f.calls.length, 0);
});
