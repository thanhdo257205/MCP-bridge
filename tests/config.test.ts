import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addSessionWorkspaces, loadConfig, sessionOnlyWorkspaces } from '../src/config.js';
import { WATCH_DELAYS_MS } from '../src/isolation/orphans.js';

test('session workspaces are merged into the allowlist for this run but never written to the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-'));
  const file = path.join(dir, 'workspaces.json');
  const saved = path.join(dir, 'saved');
  const original = JSON.stringify({allowed_workspaces: [saved]});
  await writeFile(file, original);
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  assert.deepEqual((await loadConfig()).allowed_workspaces, [saved]);
  assert.deepEqual(sessionOnlyWorkspaces(), []);
  const extra = path.join(dir, 'extra');
  addSessionWorkspaces([extra, extra, saved]);
  const config = await loadConfig();
  assert.deepEqual(config.allowed_workspaces, [saved, extra], 'deduplicated, file entries first');
  assert.deepEqual(sessionOnlyWorkspaces(), [extra], 'an entry already in the file is not session-only');
  assert.equal(await readFile(file, 'utf8'), original, 'the config file is untouched');
});
test('the prompt goes through argv by default (the mode verified with a real agy); stdin is opt-in', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-transport-'));
  const file = path.join(dir, 'workspaces.json');
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  await writeFile(file, JSON.stringify({allowed_workspaces: []}));
  assert.equal((await loadConfig()).prompt_transport, 'argv');
  await writeFile(file, JSON.stringify({allowed_workspaces: [], prompt_transport: 'stdin'}));
  assert.equal((await loadConfig()).prompt_transport, 'stdin');
  await writeFile(file, JSON.stringify({allowed_workspaces: [], prompt_transport: 'pipe'}));
  await assert.rejects(loadConfig());
  const example = JSON.parse(await readFile(new URL('../../config/workspaces.example.json', import.meta.url), 'utf8')) as {prompt_transport: string};
  assert.equal(example.prompt_transport, 'argv', 'the shipped example does not silently opt in to stdin');
});
test('task time limits: the default maximum stays 15 minutes, the owner can raise it to an hour, nothing above', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-timeout-'));
  const file = path.join(dir, 'workspaces.json');
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  await writeFile(file, JSON.stringify({allowed_workspaces: []}));
  const defaults = await loadConfig();
  assert.equal(defaults.max_timeout_seconds, 900);assert.equal(defaults.default_timeout_seconds, 300);
  await writeFile(file, JSON.stringify({allowed_workspaces: [], max_timeout_seconds: 3600, default_timeout_seconds: 1200}));
  const raised = await loadConfig();
  assert.equal(raised.max_timeout_seconds, 3600);assert.equal(raised.default_timeout_seconds, 1200);
  await writeFile(file, JSON.stringify({allowed_workspaces: [], max_timeout_seconds: 3601}));
  await assert.rejects(loadConfig());
  await writeFile(file, JSON.stringify({allowed_workspaces: [], max_timeout_seconds: 600, default_timeout_seconds: 1200}));
  await assert.rejects(loadConfig(), /Default timeout exceeds maximum/);
});
test('the tree watch cadence is the owner\'s, and a bad entry is refused instead of silently disabling the reaper', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-tree-watch-'));
  const file = path.join(dir, 'workspaces.json');
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  await writeFile(file, JSON.stringify({allowed_workspaces: []}));
  assert.equal((await loadConfig()).tree_watch, undefined, 'no entry means the built-in cadence');
  await writeFile(file, JSON.stringify({allowed_workspaces: [], tree_watch: {enabled: false}}));
  assert.equal((await loadConfig()).tree_watch?.enabled, false, 'the watch can be turned off, which is the owner saying they accept orphaned trees');
  await writeFile(file, JSON.stringify({allowed_workspaces: [], tree_watch: {delays_ms: [100, 60000]}}));
  assert.deepEqual((await loadConfig()).tree_watch?.delays_ms, [100, 60000]);
  for (const value of [{delays_ms: []}, {delays_ms: [99]}, {delays_ms: [60001]}, {delays_ms: [1.5]}, {delays_ms: 'fast'}, {enabled: 'no'}, {enabled: false, interval_ms: 5000}]) {
    await writeFile(file, JSON.stringify({allowed_workspaces: [], tree_watch: value}));
    await assert.rejects(loadConfig(), `tree_watch: ${JSON.stringify(value)}`);
  }
  // The example is the only place an owner reads this knob, so it has to parse and it has to show the real default.
  const example = JSON.parse(await readFile(new URL('../../config/workspaces.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({...example, allowed_workspaces: []}));
  assert.deepEqual((await loadConfig()).tree_watch?.delays_ms, WATCH_DELAYS_MS, 'the example documents the cadence the bridge actually runs');
  assert.equal((await loadConfig()).tree_watch?.enabled, true);
});
