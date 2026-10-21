import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { offerSkillInstall, skillPromptDisabled } from '../src/onboarding.js';
import { skillStatus } from '../scripts/install-skill.js';

const dirs = async () => ({state: await mkdtemp(path.join(tmpdir(), 'bridge-onb-state-')), home: await mkdtemp(path.join(tmpdir(), 'bridge-onb-home-'))});
const exists = (file: string) => access(file).then(() => true, () => false);
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
  const status = await skillStatus({userHome: d.home});
  assert.equal(await exists(status.codex.file) || await exists(status.claude.file), false, 'nothing was written');
});
test('onboarding: "both" installs for Codex and Claude, shows the paths first, and is never asked again', async () => {
  const d = await dirs(); const a = asker('both');
  const first = await run(d, a);
  assert.equal(first.result, 'installed');
  assert.ok(first.logs.some(line => line.includes(path.join(d.home, '.agents'))) && first.logs.some(line => line.includes(path.join(d.home, '.claude'))), 'the destinations are shown before anything is written');
  const status = await skillStatus({userHome: d.home});
  assert.equal(status.codex.state, 'installed'); assert.equal(status.claude.state, 'installed');
  assert.equal((await run(d, a)).result, 'skipped');
  assert.equal(a.asked.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(d.state, 'onboarding.json'), 'utf8')).skill_offer.choice, 'codex+claude');
});
test('onboarding: a single client can be chosen; the other stays untouched and the question is not repeated', async () => {
  const d = await dirs(); const a = asker('claude');
  assert.equal((await run(d, a)).result, 'installed');
  const status = await skillStatus({userHome: d.home});
  assert.equal(status.claude.state, 'installed'); assert.equal(status.codex.state, 'missing');
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
    assert.equal((await skillStatus({userHome: d.home})).codex.state, 'missing');
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
  const status = await skillStatus({userHome: d.home});
  await mkdir(path.dirname(status.codex.file), {recursive: true}); await writeFile(status.codex.file, 'my own notes');
  const a = asker('both');
  const {result, logs} = await run(d, a);
  assert.equal(result, 'installed');
  assert.ok(logs.some(line => /customized skill already exists/.test(line)));
  assert.equal(await readFile(status.codex.file, 'utf8'), 'my own notes');
  assert.equal((await skillStatus({userHome: d.home})).claude.state, 'installed');
  assert.ok(!a.asked[0].includes('both'), 'only one client was offered, so "both" is not a choice');
  // Every client already has a file: nothing to offer, nothing asked.
  const d2 = await dirs(); const s2 = await skillStatus({userHome: d2.home});
  for (const client of ['codex', 'claude'] as const) { await mkdir(path.dirname(s2[client].file), {recursive: true}); await writeFile(s2[client].file, 'x'); }
  const a2 = asker('both');
  assert.equal((await run(d2, a2)).result, 'skipped'); assert.equal(a2.asked.length, 0);
});
test('onboarding: an install failure is reported, does not throw, and the question is asked again next time', async () => {
  const d = await dirs(); const a = asker('both');
  const {result, logs} = await run(d, a, {install: async () => { throw new Error('EACCES: permission denied'); }});
  assert.equal(result, 'failed');
  assert.ok(logs.some(line => /Could not install: EACCES.*server starts anyway/.test(line)));
  assert.equal(await exists(path.join(d.state, 'onboarding.json')), false);
});
