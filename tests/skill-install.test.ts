import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installSkill, packagedSkills, type Client } from '../scripts/install-skill.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = (skill: string) => path.join(root, 'skills', skill, 'SKILL.md');
const SKILLS = ['antigravity-bridge', 'mission-orchestrator'];

test('skill installer copies every packaged skill for both clients and is idempotent', async () => {
  assert.deepEqual(await packagedSkills(), SKILLS, 'one folder per skill under skills/ is what the installer offers');
  const userHome = await mkdtemp(path.join(tmpdir(), 'bridge-skill-user-'));
  const installed = await installSkill({client: 'both', userHome});
  assert.deepEqual(installed.map(item => item.skill), [...SKILLS, ...SKILLS], 'every packaged skill for every chosen client');
  for (const item of installed) {assert.ok(item.filename.startsWith(userHome));assert.equal(await readFile(item.filename, 'utf8'), await readFile(source(item.skill), 'utf8'));}
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
  // Nothing is written anywhere when one destination is refused, not even the skill that was free to install.
  await assert.rejects(access(path.join(project, '.agents', 'skills', 'antigravity-bridge', 'SKILL.md')));
  await assert.rejects(access(path.join(project, '.claude', 'skills', 'mission-orchestrator', 'SKILL.md')));
  const result = await installSkill({client: 'codex', project});assert.deepEqual(result.map(item => item.skill), SKILLS);
  // A customized copy of one skill does not stop the other one from being installed next to it.
  await assert.rejects(access(path.join(project, '.claude', 'skills', 'mission-orchestrator', 'SKILL.md')));
  const one = await installSkill({client: 'claude', project, skills: ['mission-orchestrator']});
  assert.deepEqual(one.map(item => [item.skill, item.unchanged]), [['mission-orchestrator', false]]);
  assert.equal(await readFile(path.join(project, '.claude', 'skills', 'mission-orchestrator', 'SKILL.md'), 'utf8'), await readFile(source('mission-orchestrator'), 'utf8'));
  assert.equal(await readFile(filename, 'utf8'), 'user customization', 'the edited copy stays the owner\'s');
  await assert.rejects(installSkill({client: 'codex', project: 'relative'}), /absolute/);
  await assert.rejects(installSkill({client: 'invalid' as Client, project}), /--client/);
});
test('installer CLI runs from another directory and needs no bridge/AI connection', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'bridge-skill-cli-'));
  const script = fileURLToPath(new URL('../scripts/install-skill.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--client', 'codex', '--project', project], {cwd: project, encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);assert.match(result.stdout, /Installed/);
  for (const skill of SKILLS)
    assert.equal(await readFile(path.join(project, '.agents', 'skills', skill, 'SKILL.md'), 'utf8'), await readFile(source(skill), 'utf8'));
  const help = spawnSync(process.execPath, [script, '--help'], {encoding: 'utf8', windowsHide: true});
  assert.equal(help.status, 0);assert.match(help.stdout, new RegExp(SKILLS.join(', ')), 'help names the skills this package ships');
  const one = spawnSync(process.execPath, [script, '--client', 'codex', '--skill', 'mission-orchestrator', '--project', await mkdtemp(path.join(tmpdir(), 'bridge-skill-one-'))], {encoding: 'utf8', windowsHide: true});
  assert.equal(one.status, 0, one.stderr);assert.match(one.stdout, /mission-orchestrator/);
  const invalid = spawnSync(process.execPath, [script, '--client', 'other'], {encoding: 'utf8', windowsHide: true});assert.equal(invalid.status, 1);
  const unknown = spawnSync(process.execPath, [script, '--client', 'codex', '--skill', 'not-a-skill'], {encoding: 'utf8', windowsHide: true});
  assert.equal(unknown.status, 1);assert.match(unknown.stderr, /--skill must be one of/);
});
