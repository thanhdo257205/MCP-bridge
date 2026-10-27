import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_IMAGES, WATCH_DELAYS_MS, descendants, reapGuard, reapOwnedTree, startTreeWatch, type ProcessInfo, type TreeReport } from '../src/isolation/orphans.js';

const START = 1_700_000_000_000;
const row = (overrides: Partial<ProcessInfo> = {}): ProcessInfo =>
  ({pid: 601, parent_pid: 500, name: 'node.exe', created_ms: START + 1000, ...overrides});

/**
 * The identity re-read of just the doomed pids. Tests that fake the table must fake this too, otherwise the release
 * asks the real process list about pids that only exist in the test.
 */
const reRead = (table: ProcessInfo[]) => async (pids: number[]): Promise<ProcessInfo[]> =>
  table.filter(info => pids.includes(info.pid));

test('the reaper accepts only processes that can be attributed to the exited agent', () => {
  assert.equal(reapGuard(row(), {started_at_ms: START, self_pid: 900}), null, 'an ordinary child started after the task is ours');
  assert.equal(reapGuard(row({created_ms: null}), {started_at_ms: START, self_pid: 900}), null, 'a missing creation time does not block the reap');
  assert.match(reapGuard(row({name: 'LSASS.EXE'}), {started_at_ms: START, self_pid: 900}) ?? '', /protected system process/);
  assert.ok(PROTECTED_IMAGES.map(value => value.toLowerCase()).includes('lsass.exe'));
  assert.match(reapGuard(row({created_ms: START - 600_000}), {started_at_ms: START, self_pid: 900}) ?? '', /existed before this task started/);
  assert.match(reapGuard(row({pid: 900}), {started_at_ms: START, self_pid: 900}) ?? '', /this bridge process/);
  for (const pid of [0, 1, -7, 1.5]) {
    assert.match(reapGuard(row({pid}), {started_at_ms: START, self_pid: 900}) ?? '', /not a reapable process id/, String(pid));
  }
});

test('reaping releases each surviving subtree root and records what it refused', async () => {
  const killed: number[] = [];
  const table = [
    row(), row({pid: 602, name: 'cmd.exe'}),
    row({pid: 4, name: 'System'}), row({pid: 603, created_ms: START - 500_000, name: 'node.exe'}), row({pid: 900, name: 'node.exe'})
  ];
  const report = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', self_pid: 900,
    isAlive: () => false, list: async () => table, verify: reRead(table), kill: async pid => { killed.push(pid); }
  });
  assert.deepEqual(killed, [601, 602], 'the agent MCP server trees are reaped, children are never spared by name alone');
  assert.deepEqual(report.reaped, [601, 602]);
  assert.deepEqual(report.skipped.map(item => item.pid), [4, 603], 'protected and pre-existing processes are left running');
  assert.match(report.skipped[0].guard, /protected system process/);
  assert.match(report.skipped[1].guard, /existed before this task started/);
  assert.equal(report.checked, true);
  assert.notEqual(killed.includes(500), true, 'the exited pid is never signalled');
  assert.notEqual(killed.includes(900), true, 'the bridge never kills itself');
});

test('a subtree left under a shell that exited before the agent is still reaped', async () => {
  // The shape a live `agy` run produced: agent 500 started a server through shell 12848, the shell exited, and the
  // npx/node/cmd chain below it survived with a parent id that no longer resolves to anything.
  const killed: number[] = [];
  const observed = [row({pid: 12848, name: 'cmd.exe'}), row({pid: 29124, parent_pid: 12848, name: 'node.exe'})];
  const table = [
    row({pid: 29124, parent_pid: 12848, name: 'node.exe'}),
    row({pid: 4836, parent_pid: 29124, name: 'cmd.exe'}),
    row({pid: 15532, parent_pid: 4836, name: 'node.exe'}),
    row({pid: 7777, parent_pid: 4000, name: 'node.exe'})
  ];
  const report = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', self_pid: 900, observed,
    isAlive: () => false, list: async () => table, verify: reRead(table), kill: async pid => { killed.push(pid); }
  });
  assert.deepEqual(killed, [29124], 'one tree kill covers the survivors below it and nothing outside the recorded tree');
  assert.deepEqual(report.reaped, [29124]);
  assert.equal(report.tracked, 2, 'the record the watch made is reported with the release');
  assert.deepEqual(report.skipped, []);
});

test('a recycled pid does not turn an unrelated tree into ours', async () => {
  const killed: number[] = [];
  const observed = [row({pid: 12848, name: 'cmd.exe', created_ms: START + 1000})];
  const table = [
    row({pid: 12848, parent_pid: 4000, name: 'notepad.exe', created_ms: START + 90_000}),
    row({pid: 5555, parent_pid: 12848, name: 'notepad.exe'}),
    row({pid: 6001, parent_pid: 500, name: 'powershell.exe', created_ms: START + 5000})
  ];
  const report = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', self_pid: 900, observed,
    isAlive: () => false, list: async () => table, verify: reRead(table), kill: async pid => { killed.push(pid); }
  });
  assert.deepEqual(killed, [6001], 'only the process that is really below the agent is released');
  assert.equal(report.skipped.some(item => item.pid === 12848), false, 'a root that was never ours is not even a candidate');
});

test('a descendant seen only after the last poll is still below a recorded parent', () => {
  const table = [
    row({pid: 12848, parent_pid: 500}), row({pid: 29124, parent_pid: 12848}),
    row({pid: 4836, parent_pid: 29124}), row({pid: 7777, parent_pid: 4000})
  ];
  assert.deepEqual(descendants(table, 500).map(info => info.pid), [12848, 29124, 4836], 'nearest first, and nothing outside the tree');
  assert.deepEqual(descendants(table, 4000).map(info => info.pid), [7777]);
  assert.deepEqual(descendants([], 500), []);
  const loop = [row({pid: 500, parent_pid: 601, name: 'agent.exe'}), row({pid: 601, parent_pid: 500})];
  assert.deepEqual(descendants(loop, 500).map(info => info.pid), [601], 'a parent cycle cannot spin forever');
});

test('the watch records the tree while the task runs and stops when the task ends', async () => {
  const timers: (() => Promise<void>)[] = [];
  const cancelled: number[] = [];
  let ticks = 0;
  const tables = [
    [row({pid: 12848, parent_pid: 500})],
    [row({pid: 12848, parent_pid: 500}), row({pid: 29124, parent_pid: 12848})],
    [row({pid: 12848, parent_pid: 500}), row({pid: 29124, parent_pid: 12848}), row({pid: 4836, parent_pid: 29124})],
    // The reading taken while stopping: the shell that only just named its child, which no scheduled poll would see.
    [row({pid: 12848, parent_pid: 500}), row({pid: 29124, parent_pid: 12848}), row({pid: 4836, parent_pid: 29124}), row({pid: 9911, parent_pid: 4836})]
  ];
  const watch = startTreeWatch(500, {
    platform: 'win32',
    list: async () => { const table = tables[Math.min(ticks, tables.length - 1)]; ticks += 1; return table; },
    schedule: (callback, ms) => { timers.push(callback); return () => { cancelled.push(ms); }; }
  });
  assert.equal(timers.length, 1, 'the first poll comes within half a second, while the CLI is still booting its servers');
  for (const tick of [0, 1, 2]) await timers[tick]!();
  const observed = await watch.stop();
  assert.deepEqual(observed.map(info => info.pid), [12848, 29124, 4836, 9911], 'stopping takes one last reading, so a child born after the final poll is still recorded');
  await timers[3]!();
  assert.equal(timers.length, 4, 'a stopped watch schedules no further poll');
  assert.deepEqual(cancelled, [4000], 'stopping cancels the poll that was still waiting');
  assert.deepEqual(WATCH_DELAYS_MS, [500, 1000, 2000, 4000, 10000], 'dense early, then rare enough to stay under a tenth of a core');

  const failing = startTreeWatch(500, {platform: 'win32', list: async () => { throw new Error('CIM unavailable'); }, schedule: callback => { timers.push(callback); return () => {}; }});
  await timers[timers.length - 1]!();
  assert.deepEqual(await failing.stop(), [], 'a query failure costs the task nothing');
  assert.deepEqual(await startTreeWatch(500, {platform: 'linux'}).stop(), [], 'POSIX reaps by process group and needs no poll');
  assert.deepEqual(await startTreeWatch(0, {platform: 'win32'}).stop(), [], 'a launch without a pid is not watched');
});

test('a live owned process is left to terminateOwned instead of being reaped', async () => {
  let listed = false;
  const report = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', isAlive: () => true,
    list: async () => { listed = true; return []; }
  });
  assert.equal(report.checked, false);
  assert.match(report.reason ?? '', /still running/);
  assert.equal(listed, false, 'no process query is issued for a tree that is still owned');
});

test('reaping reports a failed enumeration instead of claiming the tree is clean', async () => {
  const blocked: TreeReport = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', isAlive: () => false, list: async () => { throw new Error('CIM query refused'); }
  });
  assert.equal(blocked.checked, false);
  assert.match(blocked.reason ?? '', /CIM query refused/);
  assert.deepEqual(blocked.reaped, []);

  const rows = [row({pid: 601}), row({pid: 602, parent_pid: 500})];
  const partial = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', isAlive: () => false,
    list: async () => rows, verify: reRead(rows),
    kill: async pid => { if (pid === 601) throw new Error('already exited'); }
  });
  assert.deepEqual(partial.reaped, [602]);
  assert.match(partial.skipped[0].guard, /may have exited on its own/);

  for (const pid of [0, 1, null as unknown as number]) {
    const report = await reapOwnedTree(pid, {started_at_ms: START, isAlive: () => false});
    assert.equal(report.checked, false, String(pid));
    assert.match(report.reason ?? '', /No usable process id/);
  }
});

test('a pid reissued between the tree query and the kill is never signalled', async () => {
  const killed: number[] = [];
  const table = [
    row({pid: 3001, parent_pid: 500, name: 'node.exe'}),
    row({pid: 3002, parent_pid: 500, name: 'cmd.exe'}),
    row({pid: 3003, parent_pid: 500, name: 'node.exe'})
  ];
  const report = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', self_pid: 900, isAlive: () => false, list: async () => table,
    kill: async pid => { killed.push(pid); },
    verify: async pids => {
      assert.deepEqual(pids, [3001, 3002, 3003], 'only the targets are re-read, not the whole table');
      return [
        row({pid: 3001, parent_pid: 500, name: 'notepad.exe'}),
        row({pid: 3002, parent_pid: 500, name: 'cmd.exe'}),
        row({pid: 3003, parent_pid: 500, name: 'node.exe', created_ms: null})
      ];
    }
  });
  assert.deepEqual(killed, [3002, 3003], 'the recycled pid is dropped and its siblings still get released');
  assert.deepEqual(report.reaped, [3002, 3003]);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].pid, 3001);
  assert.match(report.skipped[0].guard, /reissued/);

  const gone = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', isAlive: () => false,
    list: async () => [row({pid: 3001, parent_pid: 500})],
    verify: async () => [], kill: async pid => { killed.push(pid); }
  });
  assert.deepEqual(gone.reaped, [], 'a target that already exited is not called a reap');
  assert.deepEqual(gone.skipped, []);

  const before = killed.length;
  const unverified = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'win32', isAlive: () => false,
    list: async () => [row({pid: 3004, parent_pid: 500})],
    verify: async () => { throw new Error('CIM busy'); }, kill: async pid => { killed.push(pid); }
  });
  assert.deepEqual(unverified.reaped, [3004], 'a failed second read cannot unmake the guards already passed');
  assert.equal(killed.length, before + 1);
});

test('a POSIX agent leaves its process group behind only while members survive', async () => {
  const signals: NodeJS.Signals[] = [];
  const quiet = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'linux', isAlive: () => false, group_alive: () => false,
    signal_group: (_pid, signal) => { signals.push(signal); }
  });
  assert.equal(quiet.group_signalled, false, 'an exited group is not signalled, so an unrelated group id is never touched');
  assert.equal(signals.length, 0);

  let alive = true;
  const signalled = await reapOwnedTree(500, {
    started_at_ms: START, platform: 'linux', isAlive: () => false,
    group_alive: () => { const previous = alive; alive = false; return previous; },
    signal_group: (_pid, signal) => { signals.push(signal); },
    sleep: async () => {}
  });
  assert.equal(signalled.group_signalled, true);
  assert.deepEqual(signals, ['SIGTERM'], 'the surviving members of the agent group get one graceful signal');
});
