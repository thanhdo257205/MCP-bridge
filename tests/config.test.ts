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
test('a pool strategy from an older config is accepted but reported as having no effect', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-strategy-'));
  const file = path.join(dir, 'workspaces.json');
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  const pools = (strategy?: string) => ({allowed_workspaces: [], agents: {pools: {smart: {...(strategy ? {strategy} : {}), members: ['a', 'b']}}}});
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => { warnings.push(items.join(' ')); };
  try {
    await writeFile(file, JSON.stringify(pools()));
    await loadConfig();
    assert.deepEqual(warnings, [], 'a pool without the field says nothing');
    await writeFile(file, JSON.stringify(pools('round-robin')));
    assert.deepEqual((await loadConfig()).agents?.pools?.smart.members, ['a', 'b']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agents\.pools\."smart"\.strategy has no effect/);
  } finally {
    console.error = original;
  }
  const example = JSON.parse(await readFile(new URL('../../config/workspaces.example.json', import.meta.url), 'utf8')) as {agents: {pools: Record<string, Record<string, unknown>>}};
  for (const pool of Object.values(example.agents.pools)) assert.ok(!('strategy' in pool), 'the shipped example does not teach a field that does nothing');
});
test('a model set on an antigravity profile is reported as ignored, one set on a codex profile is not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-config-profile-model-'));
  const file = path.join(dir, 'workspaces.json');
  process.env.ANTIGRAVITY_BRIDGE_CONFIG = file;
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...items: unknown[]) => { warnings.push(items.join(' ')); };
  try {
    await writeFile(file, JSON.stringify({allowed_workspaces: [], agents: {profiles: {
      work: {adapter: 'codex', model: 'gpt-5'}, agy2: {adapter: 'antigravity'}
    }}}));
    await loadConfig();
    assert.deepEqual(warnings, [], 'a codex model and an antigravity profile without one say nothing');
    await writeFile(file, JSON.stringify({allowed_workspaces: [], agents: {profiles: {agy2: {adapter: 'antigravity', model: 'gemini-3.8-flash-high'}}}}));
    await loadConfig();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /agents\.profiles\."agy2"\.model is ignored/);
  } finally {
    console.error = original;
  }
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
test('the shipped example only shows knobs that actually work: its profiles are enabled, its pools route to them, its priority lists agents', async () => {
  const example = JSON.parse(await readFile(new URL('../../config/workspaces.example.json', import.meta.url), 'utf8')) as {
    agents?: {enabled?: string[]; priority?: string[]; profiles?: Record<string, {adapter: string}>; pools?: Record<string, {members: string[]}>};
  };
  const {enabled, priority, profiles = {}, pools = {}} = example.agents ?? {};
  // A profile is only enabled when agents.enabled lists it (registry.ts), so an example that lists adapters there ships
  // profiles nothing can run, and a pool of those members refuses with Unknown agent "<pool id>" - which points the reader
  // at the pool line instead of the enabled line.
  if (enabled !== undefined) {
    for (const [id, profile] of Object.entries(profiles)) {
      assert.ok(enabled.includes(id), `agents.profiles."${id}" must also appear in agents.enabled`);
      assert.ok(enabled.includes(profile.adapter), `agents.enabled must keep "${profile.adapter}": without the base adapter its CLI is never probed, so "${id}" is unavailable and reports no warning at all`);
    }
    for (const [id, pool] of Object.entries(pools)) {
      for (const member of pool.members) {
        assert.ok(Object.hasOwn(profiles, member), `pool "${id}" names member "${member}" which is not a declared profile`);
        assert.ok(enabled.includes(member), `pool "${id}" routes to "${member}" which agents.enabled does not enable`);
      }
    }
  }
  // default_agent matches priority against agent ids only, and a pool id passes the config's unknown-id check.
  for (const id of priority ?? [])
    assert.ok(!Object.hasOwn(pools, id), `priority entry "${id}" is a pool id, which silently selects nothing`);
});
