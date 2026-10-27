import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {startProcess, terminateOwned, TERMINATION_GRACE_MS} from '../src/antigravity/process.js';
import {reapOwnedTree} from '../src/isolation/orphans.js';
import {isAlive, waitUntilDead} from './helpers.js';

test('POSIX termination allows SIGTERM cleanup before escalating', {skip:process.platform==='win32'}, async () => {
  const child=startProcess(process.execPath,['-e',`process.on('SIGTERM',()=>{console.log('cleaned');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`],process.cwd());
  let output='';child.stdout!.on('data',chunk=>output+=chunk);
  while(!output.includes('ready'))await once(child.stdout!,'data');
  const closed=once(child,'close');await terminateOwned(child);const [code,signal]=await closed;
  assert.equal(code,0);assert.equal(signal,null);assert.match(output,/cleaned/);
});
test('POSIX termination escalates an unresponsive owned group after eight seconds', {skip:process.platform==='win32'}, async () => {
  const child=startProcess(process.execPath,['-e',`process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)`],process.cwd());
  await once(child.stdout!,'data');const closed=once(child,'close');const started=Date.now();
  await Promise.all([terminateOwned(child),terminateOwned(child)]);
  const [,signal]=await closed;assert.equal(signal,'SIGKILL');assert.ok(Date.now()-started>=TERMINATION_GRACE_MS-50);
});

/**
 * A POSIX agent is started detached so it leads its own process group, and its children inherit that group. Once the
 * agent exits those children are orphans that nothing waits on, which is what the release has to reach. These runs
 * use real processes and real signals: a fake `signal_group` would only prove the call was made, not that the group
 * dies. They are the pair that can only be observed on Linux, so they run in the ubuntu CI leg and in WSL.
 */
async function leaveASurvivor(handlesSigterm: boolean): Promise<{agentPid: number; survivorPid: number}> {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-reap-group-'));
  const marker = path.join(root, 'survivor.pid');
  const survivor = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));`
    + (handlesSigterm ? `process.on('SIGTERM', () => process.exit(0));` : `process.on('SIGTERM', () => {});`)
    + `setInterval(() => {}, 1000);`;
  // stdio is ignored and the child unref'd: the survivor must outlive the agent that spawned it, in its group.
  const agent = `const {spawn}=require('node:child_process');`
    + `const c=spawn(process.execPath,['-e',${JSON.stringify(survivor)}],{stdio:'ignore'});c.unref();`
    + `setTimeout(()=>process.exit(0),300);`;
  const child = startProcess(process.execPath, ['-e', agent], process.cwd());
  await once(child, 'close');
  const survivorPid = Number(await readFile(marker, 'utf8'));
  assert.ok(survivorPid > 1, 'the agent left a survivor behind before it exited');
  assert.equal(isAlive(survivorPid), true, 'the tree an exited agent leaves behind is still running');
  return {agentPid: child.pid!, survivorPid};
}

test('a POSIX release signals the exited agent group and a survivor that obeys SIGTERM goes quietly', {skip: process.platform === 'win32', timeout: 30000}, async () => {
  const {agentPid, survivorPid} = await leaveASurvivor(true);
  const report = await reapOwnedTree(agentPid, {started_at_ms: Date.now() - 1000});
  assert.equal(report.checked, true);
  assert.equal(report.group_signalled, true, 'members still hold the group, so it is signalled');
  assert.deepEqual(report.reaped, [], 'the group signal is not counted as one tree per member');
  assert.equal(await waitUntilDead(survivorPid, 5000), true, 'SIGTERM alone ended the group');
});

test('a POSIX release escalates the group it signalled when a member ignores SIGTERM', {skip: process.platform === 'win32', timeout: 30000}, async () => {
  const {agentPid, survivorPid} = await leaveASurvivor(false);
  const started = Date.now();
  const report = await reapOwnedTree(agentPid, {started_at_ms: started});
  assert.equal(report.group_signalled, true);
  assert.equal(report.skipped.length, 0, 'a group member is not refused by the per-pid guards, it is signalled as a group');
  assert.equal(await waitUntilDead(survivorPid, 5000), true, 'the grace ran out and the group was killed');
  assert.ok(Date.now() - started >= TERMINATION_GRACE_MS - 50, 'the survivor was given the full grace before SIGKILL');
});

test('an exited agent whose group is already empty is left completely alone', {skip: process.platform === 'win32', timeout: 30000}, async () => {
  // The group id of a dead leader can be reused by an unrelated process, so a release that signalled anyway would
  // reach outside the task. Nothing here survives the agent, so nothing may be signalled.
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-reap-empty-'));
  const child = startProcess(process.execPath, ['-e', 'process.exit(0)'], process.cwd());
  await once(child, 'close');
  const report = await reapOwnedTree(child.pid!, {started_at_ms: Date.now() - 1000});
  assert.equal(report.checked, true);
  assert.equal(report.group_signalled, false);
  assert.equal(report.reason, undefined);
});
