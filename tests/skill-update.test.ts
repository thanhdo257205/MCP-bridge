import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSkill, knownSkillHashes, skillHash, skillStatus } from '../scripts/install-skill.js';
import { offerSkillUpdate } from '../src/onboarding.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const current = await readFile(path.join(root, 'skills', 'antigravity-bridge', 'SKILL.md'), 'utf8');
const oldFirst = await readFile(path.join(root, 'tests', 'fixtures', 'skill-v1.md'), 'utf8');
const oldQueue = await readFile(path.join(root, 'tests', 'fixtures', 'skill-v4.md'), 'utf8');
const dirs = async () => ({home: await mkdtemp(path.join(tmpdir(), 'bridge-skill-home-')), state: await mkdtemp(path.join(tmpdir(), 'bridge-skill-state-'))});
const place = async (home: string, client: 'codex' | 'claude', text: string) => {
  const file = (await skillStatus({userHome: home}))[client].file;
  await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, text); return file;
};
const exists = (file: string) => access(file).then(() => true, () => false);
// The checkout may already use CRLF (Windows runners), so derive both forms from the LF form instead of converting blindly.
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const crlf = (text: string) => lf(text).replace(/\n/g, '\r\n');

test('skill versions: the list is well formed, covers history, and always includes the skill being shipped', async () => {
  const listed = JSON.parse(await readFile(path.join(root, 'skills', 'known-versions.json'), 'utf8')) as {versions: {sha256: string; note: string}[]};
  assert.ok(listed.versions.length >= 6);
  for (const entry of listed.versions) { assert.match(entry.sha256, /^[0-9a-f]{64}$/); assert.ok(entry.note); }
  assert.equal(new Set(listed.versions.map(entry => entry.sha256)).size, listed.versions.length, 'no duplicates');
  const known = await knownSkillHashes();
  assert.ok(known.has(skillHash(current)), `add ${skillHash(current)} to skills/known-versions.json: every shipped SKILL.md must be listed so it can be recognized after the next edit`);
  assert.ok(known.has(skillHash(oldFirst)), 'the first packaged skill is recognized');
  assert.ok(known.has(skillHash(oldQueue)), 'an intermediate packaged skill is recognized');
  assert.notEqual(skillHash(oldFirst), skillHash(current));
});
test('skill status: installed, outdated (older packaged copy), different (the owner edit) and missing are told apart; line endings do not matter', async () => {
  const d = await dirs();
  await place(d.home, 'codex', oldQueue);
  await place(d.home, 'claude', 'my own notes');
  let status = await skillStatus({userHome: d.home});
  assert.equal(status.codex.state, 'outdated'); assert.equal(status.claude.state, 'different');
  const e = await dirs();
  await place(e.home, 'codex', crlf(current));
  await place(e.home, 'claude', crlf(oldFirst));
  status = await skillStatus({userHome: e.home});
  assert.equal(status.codex.state, 'installed', 'a CRLF copy of this version is the same version');
  assert.equal(status.claude.state, 'outdated', 'a CRLF copy of an older version is still recognized');
  assert.equal((await skillStatus({userHome: (await dirs()).home})).codex.state, 'missing');
  assert.equal(status.currentHash, skillHash(current));
});
test('skill install: an older packaged copy needs --update; the edited one is never overwritten, even with --update', async () => {
  const d = await dirs();
  const file = await place(d.home, 'codex', oldQueue);
  await assert.rejects(installSkill({client: 'codex', userHome: d.home}), /older packaged version.*--update/);
  assert.equal(await readFile(file, 'utf8'), oldQueue, 'untouched without --update');
  const updated = await installSkill({client: 'codex', userHome: d.home, update: true});
  assert.deepEqual(updated.map(item => [item.unchanged, item.updated]), [[false, true]]);
  assert.equal(await readFile(file, 'utf8'), current);
  assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');
  assert.deepEqual((await installSkill({client: 'codex', userHome: d.home, update: true})).map(item => item.unchanged), [true], 'idempotent');

  const e = await dirs();
  const edited = await place(e.home, 'claude', oldQueue + '\nmy own rule\n');
  await assert.rejects(installSkill({client: 'claude', userHome: e.home, update: true}), /Existing skill differs from every packaged version/);
  assert.equal(await readFile(edited, 'utf8'), oldQueue + '\nmy own rule\n');
});
test('skill install: nothing is written for any client if one of them cannot be updated', async () => {
  const d = await dirs();
  const codex = await place(d.home, 'codex', oldQueue);
  const claude = await place(d.home, 'claude', 'customized');
  await assert.rejects(installSkill({client: 'both', userHome: d.home, update: true}), /differs/);
  assert.equal(await readFile(codex, 'utf8'), oldQueue, 'the outdated copy was not updated either: decisions come before writes');
  assert.equal(await readFile(claude, 'utf8'), 'customized');
});
test('skill update offer: asks once per packaged skill, only for older packaged copies, and respects the answer', async () => {
  const run = (d: {home: string; state: string}, answers: string[], extra: Record<string, unknown> = {}) => {
    const asked: string[] = []; const logs: string[] = [];
    return offerSkillUpdate({stateDirectory: d.state, userHome: d.home, interactive: true, env: {}, log: m => logs.push(m), ask: async q => { asked.push(q); return answers.shift() ?? ''; }, ...extra})
      .then(result => ({result, asked, logs}));
  };
  const d = await dirs();
  const codex = await place(d.home, 'codex', oldQueue);
  const claude = await place(d.home, 'claude', 'my own notes');
  const yes = await run(d, ['y']);
  assert.equal(yes.result, 'updated');
  assert.ok(yes.logs.some(line => line.includes(codex)) && !yes.logs.some(line => line.includes(claude)), 'only the older packaged copy is offered');
  assert.equal(await readFile(codex, 'utf8'), current);
  assert.equal(await readFile(claude, 'utf8'), 'my own notes');
  assert.equal((await run(d, ['y'])).result, 'skipped', 'nothing outdated remains');

  const e = await dirs();
  const file = await place(e.home, 'codex', oldFirst);
  const no = await run(e, ['n']);
  assert.equal(no.result, 'declined');
  assert.ok(no.logs.some(line => /skill install --client both --update/.test(line)));
  assert.equal(await readFile(file, 'utf8'), oldFirst);
  const again = await run(e, ['y']);
  assert.equal(again.result, 'skipped'); assert.equal(again.asked.length, 0, 'not asked again for the same packaged skill');
  // A newer packaged skill (different current hash) asks again.
  const status = await skillStatus({userHome: e.home});
  const next = await run(e, ['n'], {status: async () => ({...status, currentHash: 'f'.repeat(64)})});
  assert.equal(next.asked.length, 1, 'asked again when a newer skill ships');
});
test('skill update offer: not outside an interactive terminal, in CI or when opted out; failure is reported and not remembered', async () => {
  const d = await dirs();
  const file = await place(d.home, 'codex', oldQueue);
  for (const extra of [{interactive: false}, {env: {CI: 'true'}}, {env: {BRIDGE_NO_SKILL_PROMPT: '1'}}]) {
    let asked = 0;
    const result = await offerSkillUpdate({stateDirectory: d.state, userHome: d.home, interactive: true, env: {}, log: () => undefined, ask: async () => { asked++; return 'y'; }, ...extra});
    assert.equal(result, 'skipped'); assert.equal(asked, 0);
  }
  assert.equal(await readFile(file, 'utf8'), oldQueue);
  const logs: string[] = [];
  const failed = await offerSkillUpdate({stateDirectory: d.state, userHome: d.home, interactive: true, env: {}, log: m => logs.push(m), ask: async () => 'y', install: async () => { throw new Error('EACCES'); }});
  assert.equal(failed, 'failed');
  assert.ok(logs.some(line => /Could not update: EACCES.*starts anyway/.test(line)));
  assert.equal(await exists(path.join(d.state, 'onboarding.json')), false, 'asked again next time');
});
test('cli: skill install --update replaces an older packaged copy and refuses an edited one', async () => {
  const d = await dirs();
  const file = await place(d.home, 'codex', oldFirst);
  const cli = path.join(root, 'dist', 'src', 'cli.js');
  const env = {...process.env, HOME: d.home, USERPROFILE: d.home};
  const without = spawnSync(process.execPath, [cli, 'skill', 'install', '--client', 'codex'], {encoding: 'utf8', env});
  assert.equal(without.status, 1); assert.match(without.stderr, /--update/);
  assert.equal(await readFile(file, 'utf8'), oldFirst);
  const withFlag = spawnSync(process.execPath, [cli, 'skill', 'install', '--client', 'codex', '--update'], {encoding: 'utf8', env});
  assert.equal(withFlag.status, 0, withFlag.stderr); assert.match(withFlag.stdout, /Updated:/);
  assert.equal(await readFile(file, 'utf8'), current);
  await writeFile(file, 'edited by hand');
  const refused = spawnSync(process.execPath, [cli, 'skill', 'install', '--client', 'codex', '--update'], {encoding: 'utf8', env});
  assert.equal(refused.status, 1); assert.match(refused.stderr, /customized/);
  assert.equal(await readFile(file, 'utf8'), 'edited by hand');
});
