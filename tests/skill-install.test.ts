import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installSkill, type Client } from '../scripts/install-skill.js';

const source = fileURLToPath(new URL('../../skills/antigravity-bridge/SKILL.md', import.meta.url));
test('skill installer copies the exact self-contained skill for both clients and is idempotent', async () => {
  const userHome = await mkdtemp(path.join(tmpdir(), 'bridge-skill-user-'));
  const installed = await installSkill({client: 'both', userHome});
  const expected = await readFile(source, 'utf8');
  assert.equal(installed.length, 2);
  for (const item of installed) {assert.ok(item.filename.startsWith(userHome));assert.equal(await readFile(item.filename, 'utf8'), expected);}
  assert.ok(installed.some(item => item.filename.includes(`${path.sep}.agents${path.sep}`)));
  assert.ok(installed.some(item => item.filename.includes(`${path.sep}.claude${path.sep}`)));
  assert.ok((await installSkill({client: 'both', userHome})).every(item => item.unchanged));
  await assert.rejects(access(path.join(userHome, '.codex', 'config.toml')));
  await assert.rejects(access(path.join(userHome, '.claude.json')));
});
test('project installation respects explicit scope and preserves existing custom skills', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'bridge-skill-project-'));
  const filename = path.join(project, '.claude', 'skills', 'antigravity-bridge', 'SKILL.md');
  await mkdir(path.dirname(filename), {recursive: true});await writeFile(filename, 'user customization');
  await assert.rejects(installSkill({client: 'both', project}), /Existing skill differs/);
  assert.equal(await readFile(filename, 'utf8'), 'user customization');
  await assert.rejects(access(path.join(project, '.agents', 'skills', 'antigravity-bridge', 'SKILL.md')));
  const result = await installSkill({client: 'codex', project});assert.equal(result.length, 1);
  await assert.rejects(installSkill({client: 'codex', project: 'relative'}), /absolute/);
  await assert.rejects(installSkill({client: 'invalid' as Client, project}), /--client/);
});
test('installer CLI runs from another directory and needs no bridge/AI connection', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'bridge-skill-cli-'));
  const script = fileURLToPath(new URL('../scripts/install-skill.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--client', 'codex', '--project', project], {cwd: project, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);assert.match(result.stdout, /Installed/);
  assert.equal(await readFile(path.join(project, '.agents', 'skills', 'antigravity-bridge', 'SKILL.md'), 'utf8'), await readFile(source, 'utf8'));
  const invalid = spawnSync(process.execPath, [script, '--client', 'other'], {encoding: 'utf8', windowsHide: true});assert.equal(invalid.status, 1);
});
