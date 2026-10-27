import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { offerSkillInstall, skillPromptDisabled } from '../src/onboarding.js';
import { skillStatus } from '../scripts/install-skill.js';

const dirs = async () => ({state: await mkdtemp(path.join(tmpdir(), 'bridge-onb-state-')), home: await mkdtemp(path.join(tmpdir(), 'bridge-onb-home-'))});
const exists = (file: string) => access(file).then(() => true, () => false);
const status = async (home: string) => await skillStatus({userHome: home});
/** Write something into a client's copy of one skill (or every packaged skill when not named). */
async function put(home: string, client: 'codex' | 'claude', text: string, skill?: string) {
  for (const entry of (await status(home))[client]) {
    if (skill && entry.skill !== skill) continue;
    await mkdir(path.dirname(entry.file), {recursive: true}); await writeFile(entry.file, text);
  }
}
function asker(...answers: string[]) {
  const asked: string[] = [];
  return {asked, ask: async (question: string) => { asked.push(question); return answers.shift() ?? ''; }};
}
const run = (d: {state: string; home: string}, a: ReturnType<typeof asker>, extra: Record<string, unknown> = {}) => {
  const logs: string[] = [];
  return offerSkillInstall({stateDirectory: d.state, userHome: d.home, interactive: true, ask: a.ask, log: m => logs.push(m), env: {}, ...extra}).then(result => ({result, logs}));
};

test('onboarding: never asks outside an interactive terminal, in CI, or when opted out', async () => {
  const d = await dirs(); const a = asker('both');
  assert.equal((await run(d, a, {interactive: false})).result, 'skipped');
  assert.equal((await run(d, a, {env: {CI: 'true'}})).result, 'skipped');
  assert.equal((await run(d, a, {env: {BRIDGE_NO_SKILL_PROMPT: '1'}})).result, 'skipped');
  assert.equal(a.asked.length, 0);
  assert.equal(skillPromptDisabled({}), false); assert.equal(skillPromptDisabled({BRIDGE_NO_SKILL_PROMPT: 'yes'}), true);
  for (const client of ['codex', 'claude'] as const) for (const entry of await status(d.home).then(s => s[client]))
    assert.equal(await exists(entry.file), false, 'nothing was written');
});
test('onboarding: "both" installs every packaged skill for Codex and Claude, shows the paths first, and is never asked again', async () => {
  const d = await dirs(); const a = asker('both');
  const first = await run(d, a);
  assert.equal(first.result, 'installed');
  assert.ok(first.logs.some(line => line.includes(path.join(d.home, '.agents'))) && first.logs.some(line => line.includes(path.join(d.home, '.claude'))), 'the destinations are shown before anything is written');
  assert.ok(first.logs.some(line => /mission-orchestrator would be written/.test(line)), 'the offer names each skill it is about to write');
  const after = await status(d.home);
  assert.ok(after.codex.every(entry => entry.state === 'installed')); assert.ok(after.claude.every(entry => entry.state === 'installed'));
  assert.equal((await run(d, a)).result, 'skipped');
  assert.equal(a.asked.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(d.state, 'onboarding.json'), 'utf8')).skill_offer.choice, 'codex+claude');
});
test('onboarding: a single client can be chosen; the other stays untouched and the question is not repeated', async () => {
  const d = await dirs(); const a = asker('claude');
  assert.equal((await run(d, a)).result, 'installed');
  const after = await status(d.home);
  assert.ok(after.claude.every(entry => entry.state === 'installed')); assert.ok(after.codex.every(entry => entry.state === 'missing'));
  assert.equal((await run(d, a)).result, 'skipped');
});
test('onboarding: "no" (or just Enter) is remembered and writes nothing', async () => {
  for (const answer of ['n', 'No', '']) {
    const d = await dirs(); const a = asker(answer);
    const {result, logs} = await run(d, a);
    assert.equal(result, 'declined');
    assert.ok(logs.some(line => /agy-mcp-bridge skill install/.test(line)), 'tells how to install later');
    assert.equal((await run(d, a)).result, 'skipped');
    assert.equal(a.asked.length, 1);
    assert.ok((await status(d.home)).codex.every(entry => entry.state === 'missing'));
  }
});
test('onboarding: an unclear answer is asked once more, then skipped without being remembered', async () => {
  const d = await dirs(); const a = asker('maybe', 'perhaps');
  assert.equal((await run(d, a)).result, 'skipped');
  assert.equal(a.asked.length, 2);
  assert.equal(await exists(path.join(d.state, 'onboarding.json')), false, 'asked again next start');
  const b = asker('perhaps', 'codex');
  assert.equal((await run(d, b)).result, 'installed');
});
test('onboarding: a customized skill is never overwritten and is not offered', async () => {
  const d = await dirs();
  await put(d.home, 'codex', 'my own notes');
  const a = asker('both');
  const {result, logs} = await run(d, a);
  assert.equal(result, 'installed');
  assert.ok(logs.some(line => /customized antigravity-bridge skill already exists/.test(line)));
  for (const entry of (await status(d.home)).codex) assert.equal(await readFile(entry.file, 'utf8'), 'my own notes');
  assert.ok((await status(d.home)).claude.every(entry => entry.state === 'installed'));
  assert.ok(!a.asked[0].includes('both'), 'only one client was offered, so "both" is not a choice');
  // Every client already has a file: nothing to offer, nothing asked.
  const d2 = await dirs();
  for (const client of ['codex', 'claude'] as const) await put(d2.home, client, 'x');
  const a2 = asker('both');
  assert.equal((await run(d2, a2)).result, 'skipped'); assert.equal(a2.asked.length, 0);
});
test('onboarding: an edited copy of one skill does not block the other skill from being offered and installed', async () => {
  const d = await dirs();
  await put(d.home, 'codex', 'my own notes', 'antigravity-bridge');
  const a = asker('codex');
  const {result, logs} = await run(d, a);
  assert.equal(result, 'installed');
  assert.ok(logs.some(line => /customized antigravity-bridge skill already exists/.test(line)), 'says which file it is keeping away from');
  assert.ok(logs.some(line => /mission-orchestrator would be written to/.test(line)));
  const after = await status(d.home);
  assert.deepEqual(after.codex.map(entry => [entry.skill, entry.state]), [['antigravity-bridge', 'different'], ['mission-orchestrator', 'installed']]);
  assert.equal(await readFile(after.codex.find(entry => entry.skill === 'antigravity-bridge')!.file, 'utf8'), 'my own notes');
});
test('onboarding: an install failure is reported, does not throw, and the question is asked again next time', async () => {
  const d = await dirs(); const a = asker('both');
  const {result, logs} = await run(d, a, {install: async () => { throw new Error('EACCES: permission denied'); }});
  assert.equal(result, 'failed');
  assert.ok(logs.some(line => /Could not install: EACCES.*server starts anyway/.test(line)));
  assert.equal(await exists(path.join(d.state, 'onboarding.json')), false);
});
