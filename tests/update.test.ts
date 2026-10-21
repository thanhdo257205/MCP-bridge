import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkForUpdate, compareVersions, fetchLatest, installArgs, isSnoozed, snooze, updateCheckEnabled } from '../src/update.js';

const pkg = {name: 'agy-mcp-bridge', version: '0.1.0'};
const reply = (version: unknown, ok = true) => (async () => ({ok, json: async () => ({version})}) as Response) as typeof fetch;
const counting = (version: unknown) => { const calls: string[] = []; const impl = (async (url: string) => { calls.push(String(url)); return {ok: true, json: async () => ({version})} as Response; }) as unknown as typeof fetch; return {calls, impl}; };
const dir = () => mkdtemp(path.join(tmpdir(), 'bridge-update-'));

test('version comparison orders releases and prereleases', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0, 'numeric, not lexical');
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('0.1.0-beta.1', '0.1.0') < 0);
  assert.ok(compareVersions('0.1.0', '0.1.0-beta.1') > 0);
});
test('update check is on only for an npm install, and every opt-out wins', () => {
  assert.equal(updateCheckEnabled('installed', {}), true);
  assert.equal(updateCheckEnabled('checkout', {}), false);
  assert.equal(updateCheckEnabled('installed', {BRIDGE_NO_UPDATE_CHECK: '1'}), false);
  assert.equal(updateCheckEnabled('installed', {BRIDGE_NO_UPDATE_CHECK: 'true'}), false);
  assert.equal(updateCheckEnabled('installed', {CI: 'true'}), false);
  assert.equal(updateCheckEnabled('checkout', {BRIDGE_UPDATE_CHECK: 'force'}), true);
  assert.equal(updateCheckEnabled('installed', {BRIDGE_UPDATE_CHECK: 'force', BRIDGE_NO_UPDATE_CHECK: '1'}), false, 'the owner opt-out beats the development override');
  assert.equal(updateCheckEnabled('checkout', {BRIDGE_UPDATE_CHECK: 'force', CI: 'true'}), false);
});
test('registry answers are validated; failures mean "unknown", never an exception', async () => {
  assert.equal(await fetchLatest('agy-mcp-bridge', {fetchImpl: reply('1.2.3')}), '1.2.3');
  assert.equal(await fetchLatest('agy-mcp-bridge', {fetchImpl: reply('1.2.3-rc.1')}), '1.2.3-rc.1');
  for (const bad of ['latest', '1.2', '1.2.3; rm -rf /', '', 7, null]) assert.equal(await fetchLatest('agy-mcp-bridge', {fetchImpl: reply(bad)}), null, String(bad));
  assert.equal(await fetchLatest('agy-mcp-bridge', {fetchImpl: reply('1.2.3', false)}), null);
  assert.equal(await fetchLatest('agy-mcp-bridge', {fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch}), null);
  const {calls, impl} = counting('1.0.0');
  await fetchLatest('@scope/name', {registry: 'http://registry.example/', fetchImpl: impl});
  assert.deepEqual(calls, ['http://registry.example/@scope%2Fname/latest']);
});
test('check asks the registry at most once a day, reports only newer versions, and honors opt-out', async () => {
  const stateDirectory = await dir();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => clock;
  const {calls, impl} = counting('0.2.0');
  const options = {stateDirectory, pkg, now, fetchImpl: impl, mode: 'installed' as const, env: {}};
  assert.deepEqual(await checkForUpdate(options), {current: '0.1.0', latest: '0.2.0'});
  assert.equal(calls.length, 1);
  clock += 60 * 60 * 1000;
  assert.deepEqual(await checkForUpdate(options), {current: '0.1.0', latest: '0.2.0'});
  assert.equal(calls.length, 1, 'cached for a day');
  assert.equal((await checkForUpdate({...options, force: true})) !== null, true);
  assert.equal(calls.length, 2);
  clock += 25 * 60 * 60 * 1000;
  await checkForUpdate(options);
  assert.equal(calls.length, 3, 'stale cache refreshes');
  assert.equal(await checkForUpdate({...options, env: {BRIDGE_NO_UPDATE_CHECK: '1'}}), null);
  assert.equal(calls.length, 3, 'opt-out makes no request');
  assert.equal(await checkForUpdate({...options, stateDirectory: await dir(), pkg: {...pkg, version: '0.2.0'}}), null, 'equal version is not an update');
  assert.equal(await checkForUpdate({...options, stateDirectory: await dir(), pkg: {...pkg, version: '0.3.0'}}), null, 'older latest is not an update');
  assert.equal(JSON.parse(await readFile(path.join(stateDirectory, 'update-check.json'), 'utf8')).latest, '0.2.0');
});
test('an unreachable registry never produces an update and is retried next start', async () => {
  const stateDirectory = await dir();
  const failing = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal(await checkForUpdate({stateDirectory, pkg, fetchImpl: failing, mode: 'installed', env: {}}), null);
  const {calls, impl} = counting('0.5.0');
  assert.notEqual(await checkForUpdate({stateDirectory, pkg, fetchImpl: impl, mode: 'installed', env: {}}), null);
  assert.equal(calls.length, 1);
});
test('declining an update snoozes only that version for a day', async () => {
  const stateDirectory = await dir();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => clock;
  assert.equal(await isSnoozed(stateDirectory, '0.2.0', now), false);
  await snooze(stateDirectory, '0.2.0', now);
  assert.equal(await isSnoozed(stateDirectory, '0.2.0', now), true);
  assert.equal(await isSnoozed(stateDirectory, '0.3.0', now), false);
  clock += 25 * 60 * 60 * 1000;
  assert.equal(await isSnoozed(stateDirectory, '0.2.0', now), false);
});
test('the install command is a fixed argument vector for the exact version found', () => {
  assert.deepEqual(installArgs('agy-mcp-bridge', '0.2.0'), ['install', '-g', 'agy-mcp-bridge@0.2.0']);
});
