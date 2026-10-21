import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addSessionWorkspaces, loadConfig, sessionOnlyWorkspaces } from '../src/config.js';

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
