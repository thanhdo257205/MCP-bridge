import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateWorkspace} from '../src/security/workspace.js';

test('workspace scan skips dependency/Git internals but checks remaining links and input aliases', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-links-')));
  const workspace = path.join(root, 'work'), outside = path.join(root, 'outside');
  await mkdir(workspace); await mkdir(outside);
  const target = path.join(workspace, 'target'); await mkdir(target);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await mkdir(path.join(workspace, 'node_modules', '.bin'), {recursive:true});
  await symlink(target, path.join(workspace, 'node_modules', '.bin', 'x'), type);
  await mkdir(path.join(workspace, '.git'));
  await symlink(outside, path.join(workspace, '.git', 'ignored'), type);
  await symlink(target, path.join(workspace, 'internal'), type);
  assert.equal(await validateWorkspace(workspace, [workspace]), workspace);
  await assert.rejects(validateWorkspace(path.join(workspace, 'internal'), [workspace]), /path contains/);
  if (process.platform !== 'win32') {
    await writeFile(path.join(target, 'bin'), 'mock executable');
    await symlink(path.join(target, 'bin'), path.join(workspace, 'node_modules', '.bin', 'file-bin'));
    assert.equal(await validateWorkspace(workspace, [workspace]), workspace);
  }
  await symlink(outside, path.join(workspace, 'escape'), type);
  await assert.rejects(validateWorkspace(workspace, [workspace]), /outside the workspace/);
});
