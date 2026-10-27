import { spawn } from 'node:child_process';
import { TERMINATION_GRACE_MS } from '../antigravity/process.js';

/**
 * An agent CLI started as a child of the bridge is not the whole process tree: it launches its own MCP servers,
 * shells and tool helpers. On Windows those grandchildren keep `ParentProcessId` pointing at the process that
 * spawned them, and each of them holds its working directory open — which is the worktree root for a delegated
 * task. A surviving tree therefore pins `<state>/worktrees/<task id>` so `git worktree remove`, `rm -rf` and even
 * `npm install -g` fail with EBUSY while the directory looks empty.
 *
 * A snapshot taken after the agent has exited is not enough, and a live run proved it: `agy` starts a server through
 * a short-lived shell, that shell exits, and everything below it is then addressed by a parent id that no longer
 * exists — invisible to a child query of the agent pid. So the tree is recorded *while the task runs* (startTreeWatch)
 * and released against that record (reapOwnedTree), which re-parents the survivors from the live process table.
 */
export interface ChildInfo {
  pid: number;
  name: string;
  /** Unix ms of process creation, or null when the enumeration could not read it. */
  created_ms: number | null;
}

export interface ProcessInfo extends ChildInfo {
  parent_pid: number;
}

export interface TreeReport {
  checked: boolean;
  reason?: string;
  /** Trees that were asked to terminate. */
  reaped: number[];
  /** Descendants deliberately left running, with the guard that refused them. */
  skipped: {pid: number; name: string; guard: string}[];
  /** Descendants the watch had recorded when the task finished. */
  tracked?: number;
  /** POSIX only: whether the exited child's process group still had members and was signalled. */
  group_signalled?: boolean;
}

/**
 * OS singletons that must never be reaped even if a recycled pid claims them as children of our exited agent.
 * `cmd.exe` and `powershell.exe` are absent on purpose: they are genuine members of a real agent tree.
 */
export const PROTECTED_IMAGES = [
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'taskhostw.exe', 'sihost.exe', 'ctfmon.exe'
];

/** Clock granularity plus scheduling slack, so a child started microseconds before the recorded start is still ours. */
const CREATION_SLACK_MS = 5000;

export type Guard = string | null;

/** Pure so the safety rules are testable without touching the process table. */
export function reapGuard(child: ChildInfo, guard: {started_at_ms: number; self_pid?: number}, protectedImages = PROTECTED_IMAGES): Guard {
  if (!Number.isInteger(child.pid) || child.pid <= 1) return 'pid is not a reapable process id';
  if (child.pid === (guard.self_pid ?? process.pid)) return 'pid is this bridge process';
  const name = child.name.toLowerCase();
  if (protectedImages.includes(name)) return `${child.name} is a protected system process`;
  if (child.created_ms !== null && child.created_ms < guard.started_at_ms - CREATION_SLACK_MS) return 'process existed before this task started';
  return null;
}

function powershell(command: string, timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    let text = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    child.stdout!.on('data', (data: Buffer) => { if (text.length < 262144) text += data.toString('utf8'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); resolve(text); });
  });
}

/**
 * Tab-separated so a name containing spaces cannot be mis-split. The whole process table is cheaper than one
 * query per pid, and CommandLine is left out because it roughly doubles the cost of a query that repeats.
 */
function tableQuery(): string {
  return 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { ' +
    '$d = if ($_.CreationDate) { [int64]([System.DateTimeOffset]::new([System.TimeZoneInfo]::ToUniversalTime($_.CreationDate)).ToUnixTimeMilliseconds()) } else { -1 }; ' +
    '"{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $d }';
}

function parseTable(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.split('\t');
    if (columns.length < 3) continue;
    const pid = Number.parseInt(columns[0], 10);
    const parent_pid = Number.parseInt(columns[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parent_pid)) continue;
    const created = Number.parseInt(columns[3] ?? '', 10);
    rows.push({pid, parent_pid, name: columns[2] ?? '',
      created_ms: Number.isInteger(created) && created >= 0 ? created : null});
  }
  return rows;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  return parseTable(await powershell(tableQuery()));
}

/**
 * The same rows, but only for the pids about to be killed. Every id is validated first because it is spliced into a
 * WQL filter string.
 */
export async function listProcessesById(pids: number[]): Promise<ProcessInfo[]> {
  if (!pids.length) return [];
  if (!pids.every(pid => Number.isInteger(pid) && pid > 1)) throw new Error('A process id to verify must be a positive integer');
  const filter = pids.map(pid => `ProcessId=${pid}`).join(' OR ');
  return parseTable(await powershell(tableQuery().replace('Win32_Process -Property', `Win32_Process -Filter '${filter}' -Property`)));
}

/** Every row below `root`, nearest first, without the root itself. */
export function descendants(table: ProcessInfo[], root: number): ProcessInfo[] {
  const childrenOf = new Map<number, ProcessInfo[]>();
  for (const row of table) {
    const siblings = childrenOf.get(row.parent_pid);
    if (siblings) siblings.push(row);
    else childrenOf.set(row.parent_pid, [row]);
  }
  const found: ProcessInfo[] = [];
  const seen = new Set<number>([root]);
  for (let frontier = [root]; frontier.length;) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of childrenOf.get(pid) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        found.push(child);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return found;
}

export interface TreeWatch {
  /**
   * Stops polling and returns every descendant seen since the task started. The last enumeration is awaited because a
   * shell that is still alive at this moment names children the earlier ticks had not seen yet.
   */
  stop(): ProcessInfo[] | Promise<ProcessInfo[]>;
}

/**
 * Denser while the CLI is booting its servers, then steady: a missed short-lived shell loses a whole subtree.
 * Each gap is measured after the previous query finished, and one query costs about half a second, so the tail
 * stays long on purpose to keep the watcher well under a tenth of a core.
 */
export const WATCH_DELAYS_MS = [500, 1000, 2000, 4000, 10000];

/**
 * Records the agent's descendant tree while it runs, because the shells that hold the deepest children exit before
 * the agent does. Best effort on every axis: a failed query is skipped, the next tick can still see the tree.
 */
export function startTreeWatch(pid: number, options: {
  list?: () => Promise<ProcessInfo[]>;
  platform?: NodeJS.Platform;
  delays?: number[];
  schedule?: (callback: () => Promise<void>, ms: number) => () => void;
} = {}): TreeWatch {
  const delays = options.delays ?? WATCH_DELAYS_MS;
  if ((options.platform ?? process.platform) !== 'win32' || !Number.isInteger(pid) || pid <= 1) return {stop: () => []};
  const list = options.list ?? listProcesses;
  const observed = new Map<number, ProcessInfo>();
  let stopped = false;
  let cancel: (() => void) | null = null;
  const poll = async (index: number): Promise<void> => {
    try {
      for (const info of descendants(await list(), pid)) observed.set(info.pid, info);
    } catch { /* the next tick gets another chance; the release is a convenience, not a guarantee */ }
    if (!stopped) wait(index + 1);
  };
  const wait = (index: number): void => {
    const at = Math.min(index, delays.length - 1);
    const schedule = options.schedule ?? ((callback: () => Promise<void>, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return () => { clearTimeout(timer); }; });
    cancel = schedule(() => poll(at), delays[at]);
  };
  wait(0);
  return {
    async stop(): Promise<ProcessInfo[]> {
      stopped = true;
      cancel?.();
      try {
        for (const info of descendants(await list(), pid)) observed.set(info.pid, info);
      } catch { /* the release still has everything the polls recorded */ }
      return [...observed.values()];
    }
  };
}

async function killTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ['/PID', String(pid), '/T', '/F'], {shell: false, windowsHide: true, stdio: 'ignore'});
    killer.once('error', reject);
    killer.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)));
  });
}

const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
};

export interface ReapOptions {
  started_at_ms: number;
  platform?: NodeJS.Platform;
  self_pid?: number;
  /** True while the owned agent process is still running: its live tree belongs to terminateOwned. */
  isAlive?: (pid: number) => boolean;
  list?: () => Promise<ProcessInfo[]>;
  /** Descendants recorded by startTreeWatch while the task was running. */
  observed?: ProcessInfo[];
  /** Re-reads exactly the pids about to be killed, so a number reissued after the tree query is never killed. */
  verify?: (pids: number[]) => Promise<ProcessInfo[]>;
  kill?: (pid: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** POSIX only: whether any member of the exited child's process group is still alive. */
  group_alive?: (pid: number) => boolean;
  /** POSIX only: signals the whole process group led by the exited child. */
  signal_group?: (pid: number, signal: NodeJS.Signals) => void;
}
/**
 * Releases whatever the agent left behind after it exited. Candidates are the processes still hanging below the
 * agent or below any process the watch recorded while it ran, and each subtree root must pass reapGuard, so this
 * cannot wander into an unrelated tree. `taskkill /T` covers the children of a root, so only roots are killed.
 */
export async function reapOwnedTree(pid: number, options: ReapOptions): Promise<TreeReport> {
  const platform = options.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 1) return {checked: false, reason: 'No usable process id was recorded for this task', reaped: [], skipped: []};
  const alive = options.isAlive ?? (value => {
    try { process.kill(value, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  });
  if (alive(pid)) return {checked: false, reason: 'Owned process is still running; its tree is terminated by cancel or timeout instead', reaped: [], skipped: []};

  if (platform !== 'win32') {
    // POSIX spawns the agent detached, so it led its own group and every descendant inherited that group id.
    const inGroup = options.group_alive ?? groupAlive;
    const signal = options.signal_group ?? ((target: number, value: NodeJS.Signals) => { process.kill(-target, value); });
    if (!inGroup(pid)) return {checked: true, reaped: [], skipped: [], group_signalled: false};
    try { signal(pid, 'SIGTERM'); }
    catch { return {checked: true, reaped: [], skipped: [], group_signalled: false}; }
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + TERMINATION_GRACE_MS;
    while (inGroup(pid)) {
      if (Date.now() >= deadline) { try { signal(pid, 'SIGKILL'); } catch { /* the group exited in the race */ } break; }
      await sleep(50);
    }
    return {checked: true, reaped: [], skipped: [], group_signalled: true};
  }

  const observed = new Map(options.observed?.map(info => [info.pid, info]) ?? []);
  let table: ProcessInfo[];
  try { table = await (options.list ?? listProcesses)(); }
  catch (error) { return {checked: false, reason: `Could not enumerate the agent process tree: ${error instanceof Error ? error.message : 'query failed'}`, reaped: [], skipped: [], tracked: observed.size}; }
  const tableByPid = new Map(table.map(row => [row.pid, row]));
  const recycled = (info: ProcessInfo, current: ProcessInfo): boolean =>
    info.name.toLowerCase() !== current.name.toLowerCase()
    || (info.created_ms !== null && current.created_ms !== null && info.created_ms !== current.created_ms);
  // A recorded parent that is gone still names its children, which is exactly what a child query cannot recover.
  // A recorded parent that is alive again under the same number but is a different process is not a parent of ours.
  const roots = new Set<number>([pid]);
  for (const [recorded, info] of observed) {
    const current = tableByPid.get(recorded);
    if (!current || !recycled(info, current)) roots.add(recorded);
  }
  const candidates = table.filter(row => row.pid !== pid && roots.has(row.parent_pid));
  const tops = candidates.filter(row => !candidates.some(other => other.pid === row.parent_pid));
  const reaped: number[] = [];
  const skipped: TreeReport['skipped'] = [];
  const kill = options.kill ?? killTree;
  // Enumeration and termination are not one atomic act: every kill is awaited, so a pid can be reissued while the
  // loop runs. Re-reading just the targets costs one filtered query instead of a second full table.
  let targets = tops;
  if (tops.length) {
    try {
      const fresh = new Map((await (options.verify ?? listProcessesById)(tops.map(row => row.pid))).map(row => [row.pid, row]));
      targets = [];
      for (const candidate of tops) {
        const now = fresh.get(candidate.pid);
        if (!now) continue;
        if (recycled(candidate, now)) skipped.push({pid: candidate.pid, name: candidate.name, guard: 'pid was reissued to another process after the tree query'});
        else targets.push(now);
      }
    } catch { /* the second read is an extra guard; the checks already made against the tree query still stand */ }
  }
  for (const child of targets) {
    const info = observed.get(child.pid);
    if (info && recycled(info, child)) {
      skipped.push({pid: child.pid, name: child.name, guard: 'pid was recycled for an unrelated process after the task ended'});
      continue;
    }
    const guard = reapGuard(child, {started_at_ms: options.started_at_ms, self_pid: options.self_pid});
    if (guard) { if (child.pid !== (options.self_pid ?? process.pid)) skipped.push({pid: child.pid, name: child.name, guard}); continue; }
    try { await kill(child.pid); reaped.push(child.pid); }
    catch { skipped.push({pid: child.pid, name: child.name, guard: 'termination request failed (it may have exited on its own)'}); }
  }
  return {checked: true, reaped, skipped, tracked: observed.size};
}
