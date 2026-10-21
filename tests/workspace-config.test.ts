import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addWorkspace, listWorkspaces, removeWorkspace } from '../src/workspace-config.js';

test('workspaces can be added, listed and removed without disturbing other settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-ws-'));
  const file = path.join(root, 'cfg', 'workspaces.json');
  const project = path.join(root, 'project'); await mkdir(project);
  const bridge = path.join(root, 'bridge'); await mkdir(bridge);
  assert.deepEqual(await listWorkspaces(file), []);
  const added = await addWorkspace(file, project, bridge);
  assert.equal(added.added, true);
  assert.deepEqual(await listWorkspaces(file), [added.path]);
  assert.equal((await addWorkspace(file, project, bridge)).added, false, 'no duplicates');
  await writeFile(file, JSON.stringify({allowed_workspaces: [added.path], max_queued_tasks: 7}));
  const second = path.join(root, 'second'); await mkdir(second);
  await addWorkspace(file, second, bridge);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).max_queued_tasks, 7, 'other keys are preserved');
  assert.equal((await removeWorkspace(file, project)).removed, true);
  assert.equal((await removeWorkspace(file, project)).removed, false);
  assert.equal((await listWorkspaces(file)).length, 1);
});
test('invalid workspaces are refused: relative, missing, not a directory, or the bridge itself', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-ws-'));
  const file = path.join(root, 'workspaces.json');
  const bridge = path.join(root, 'bridge'); await mkdir(path.join(bridge, 'src'), {recursive: true});
  await writeFile(path.join(root, 'file.txt'), 'x');
  await assert.rejects(addWorkspace(file, 'relative/dir', bridge), /absolute/);
  await assert.rejects(addWorkspace(file, path.join(root, 'missing'), bridge), /does not exist/);
  await assert.rejects(addWorkspace(file, path.join(root, 'file.txt'), bridge), /Not a directory/);
  await assert.rejects(addWorkspace(file, bridge, bridge), /bridge installation/);
  await assert.rejects(addWorkspace(file, path.join(bridge, 'src'), bridge), /bridge installation/);
  await assert.rejects(addWorkspace(file, root, bridge), /bridge installation/, 'a parent of the bridge would include its source');
  assert.deepEqual(await listWorkspaces(file), []);
});
test('a corrupt config is reported, never overwritten', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-ws-'));
  const file = path.join(root, 'workspaces.json'); await writeFile(file, '{not json');
  const project = path.join(root, 'p'); await mkdir(project);
  await assert.rejects(addWorkspace(file, project, path.join(root, 'nowhere-yet')), /Cannot read|ENOENT|does not exist/);
  await mkdir(path.join(root, 'bridge'));
  await assert.rejects(addWorkspace(file, project, path.join(root, 'bridge')), /Cannot read/);
  assert.equal(await readFile(file, 'utf8'), '{not json');
});
