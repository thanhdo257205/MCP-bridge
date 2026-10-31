import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { workspaceChanges } from '../changes.js';
import { inside } from '../security/workspace.js';

export interface Worktree {
  /** Git worktree root. */
  root: string;
  /** The requested workspace directory inside the worktree (differs when the workspace is a subdirectory). */
  workspace: string;
  /** Repository root of the original workspace. */
  toplevel: string;
  branch: string;
  /** Repo-relative path of the workspace inside the worktree, using forward slashes and no trailing slash. */
  prefix: string;
  base: string;
}

export interface ScopeReport {
  checked: boolean;
  reason?: string;
  changed: number;
  out_of_scope: string[];
  truncated: boolean;
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
  TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C'
});

function git(cwd: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, env: gitEnvironment(), timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n')[0].slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** A worktree is created from HEAD only; uncommitted changes in the original workspace are intentionally not copied. */
export async function createWorktree(options: { workspace: string; stateDirectory: string; taskId: string }): Promise<Worktree> {
  let toplevel: string;
  let prefix: string;
  let base: string;
  try {
    toplevel = (await git(options.workspace, ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'])).trim();
    prefix = (await git(options.workspace, ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-prefix'])).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    base = (await git(options.workspace, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch (error) {
    throw new Error(`Worktree isolation requires a git repository with at least one commit: ${error instanceof Error ? error.message : 'git failed'}`);
  }
  if (!toplevel || !base) throw new Error('Worktree isolation requires a git repository with at least one commit');
  const worktreesDirectory = path.join(options.stateDirectory, 'worktrees');
  const root = path.join(worktreesDirectory, options.taskId);
  const branch = `bridge/${options.taskId}`;
  await mkdir(worktreesDirectory, {recursive: true});
  const hooks = path.join(options.stateDirectory, 'empty-hooks');
  await mkdir(hooks, {recursive: true});
  await git(toplevel, [
    '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`,
    'worktree', 'add', '-b', branch, root, base
  ]);
  const workspace = prefix ? path.join(root, ...prefix.split('/')) : root;
  const [realRoot, realWorkspace] = await Promise.all([realpath(root), realpath(workspace)]);
  if (!inside(realRoot, realWorkspace)) throw new Error('Worktree workspace resolves outside the worktree');
  return {root: realRoot, workspace: realWorkspace, toplevel, branch, prefix, base};
}

/** Result of a removal attempt: a busy worktree directory must be reported, never silently kept. */
export interface RemovalResult {
  removed: boolean;
  reason?: string;
}

export interface SweepReport {
  scanned: number;
  removed: string[];
  retained: {path: string; reason: string}[];
  /** Repositories whose worktree directory was deleted without git, so their admin record may still list it. */
  prunable: string[];
}

/**
 * Best effort and only for a launch that never started a process: no files were touched by the agent.
 * A Windows process that still holds the directory makes `git worktree remove` fail, so the attempt is retried
 * briefly and the outcome is returned instead of dropped.
 */
export async function removeWorktree(worktree: Worktree, options: {retryDelayMs?: number[]} = {}): Promise<RemovalResult> {
  const delays = options.retryDelayMs ?? [0, 200, 600];
  let reason = '';
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try { await git(worktree.toplevel, ['worktree', 'remove', '--force', worktree.root]); }
    catch (error) { reason = error instanceof Error ? error.message : 'git worktree remove failed'; }
    if (!await exists(worktree.root)) {
      await git(worktree.toplevel, ['branch', '-D', worktree.branch]).catch(() => {});
      return {removed: true};
    }
    reason = `The worktree directory is still held by a running process${reason ? ` (last error: ${reason})` : ''}`;
  }
  return {removed: false, reason};
}

const exists = async (target: string): Promise<boolean> => {
  try { await stat(target); return true; } catch { return false; }
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f-]+$/;
const TASK_RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** What a sweep needs from a task record: whether it is still live, and the two paths that tie it to a repository. */
export interface TaskRecord {
  status: string | null;
  /** Repository root the worktree was added to. */
  repo: string | null;
  /** Worktree directory the task was given. */
  worktree: string | null;
}

/**
 * Drops worktree directories that a previous run could not remove because a process the bridge no longer owned
 * was holding them open. Only genuinely empty directories go: anything with content is a diff someone may still
 * be reviewing, and stale locks on real work are left for a human.
 */
export async function sweepStaleWorktrees(stateDirectory: string, options: {
  readRecord?: (taskId: string) => Promise<TaskRecord>;
  remove?: (directory: string, repo: string | null) => Promise<'git' | 'rmdir'>;
  retryDelayMs?: number[];
} = {}): Promise<SweepReport> {
  const directory = path.join(stateDirectory, 'worktrees');
  const report: SweepReport = {scanned: 0, removed: [], retained: [], prunable: []};
  let names: string[];
  try { names = await readdir(directory); }
  catch { return report; }
  const readRecord = options.readRecord ?? (async (taskId: string) => {
    try {
      const parsed = JSON.parse(await readFile(path.join(stateDirectory, 'tasks', `${taskId}.json`), 'utf8')) as
        {status?: string; task?: {status?: string; worktree?: string | null; worktree_toplevel?: string | null}};
      return {status: parsed.task?.status ?? parsed.status ?? null, repo: parsed.task?.worktree_toplevel ?? null, worktree: parsed.task?.worktree ?? null};
    } catch { return {status: null, repo: null, worktree: null}; }
  });
  const queuePrune = (repo: string): void => { if (!report.prunable.includes(repo)) report.prunable.push(repo); };
  // Removing through git also drops the admin record under <repo>/.git/worktrees, which a plain rmdir leaves behind as
  // a stale entry that then makes every later `git worktree` command in that repository complain.
  const remove = options.remove ?? (async (target: string, repo: string | null) => {
    if (repo) {
      try { await git(repo, ['worktree', 'remove', '--force', target]); return 'git'; } catch { /* the directory may be gone already */ }
    }
    await rmdir(target);
    return 'rmdir';
  });
  for (const name of names) {
    const candidate = path.join(directory, name);
    report.scanned += 1;
    if (!TASK_ID.test(name)) { report.retained.push({path: candidate, reason: 'not a task worktree directory'}); continue; }
    let record: TaskRecord;
    try { record = await readRecord(name); }
    catch { report.retained.push({path: candidate, reason: 'its task record could not be read'}); continue; }
    if (record.status === 'queued' || record.status === 'running') { report.retained.push({path: candidate, reason: `task is ${record.status}`}); continue; }
    let entries: string[];
    try { entries = await readdir(candidate); }
    catch (error) {
      // The directory is already gone — deleted without git, which is exactly what leaves a stale admin record behind.
      if ((error as {code?: string}).code === 'ENOENT') { if (record.repo) queuePrune(record.repo); continue; }
      report.retained.push({path: candidate, reason: error instanceof Error ? error.message : 'directory could not be read'});
      continue;
    }
    if (entries.length) { report.retained.push({path: candidate, reason: 'it still holds files for review'}); continue; }
    let reason = '';
    let how: 'git' | 'rmdir' = 'rmdir';
    for (const delay of options.retryDelayMs ?? [0, 200, 600]) {
      if (delay) await sleep(delay);
      try { how = await remove(candidate, record.repo); reason = ''; break; }
      catch (error) { reason = error instanceof Error ? error.message : 'directory could not be removed'; }
    }
    if (reason) report.retained.push({path: candidate, reason});
    else {
      report.removed.push(candidate);
      // A git removal took the admin record with it; anything else that cleared the directory left the record behind.
      if (how === 'rmdir' && record.repo) queuePrune(record.repo);
    }
  }
  // A directory deleted by hand never shows up in the listing above, so the task records are read as well: a finished
  // task naming a worktree that is no longer on disk is the other way a repository ends up holding a dead entry.
  let records: string[];
  try { records = await readdir(path.join(stateDirectory, 'tasks')); }
  catch { return report; }
  for (const file of records) {
    if (!TASK_RECORD.test(file)) continue;
    let record: TaskRecord;
    try { record = await readRecord(file.slice(0, -'.json'.length)); }
    catch { continue; }
    if (record.status === 'queued' || record.status === 'running') continue;
    if (!record.repo || !record.worktree || await exists(record.worktree)) continue;
    queuePrune(record.repo);
  }
  return report;
}


interface ListedWorktree { path: string; locked: boolean; }

/** Worktrees the repository still has a record for, including the ones whose directory is already gone. */
async function listedWorktrees(repo: string): Promise<ListedWorktree[]> {
  const text = await git(repo, ['worktree', 'list', '--porcelain']);
  const listed: ListedWorktree[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const line = lines.find(item => item.startsWith('worktree '));
    const target = line?.slice('worktree '.length).trim();
    if (target) listed.push({path: target, locked: lines.some(item => item === 'locked' || item.startsWith('locked '))});
  }
  return listed;
}

const samePath = (a: string, b: string): boolean => {
  const [left, right] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * Clears the `<repo>/.git/worktrees/<name>` entries the bridge's own worktrees left behind when their directory went
 * away without git. `git worktree prune` cannot be pointed at one record: it takes every record whose directory is
 * missing, including a worktree the user made by hand that is merely on an unmounted drive. So the entry is removed
 * the way prune would remove it, one at a time, and only when its directory is missing, lies under `worktreesRoot`
 * (where the bridge puts its worktrees) and is not locked. Anything else is left for its owner.
 */
export async function pruneWorktrees(repo: string, worktreesRoot: string): Promise<{pruned: number; reason: string}> {
  try {
    const missing: string[] = [];
    for (const item of await listedWorktrees(repo)) {
      if (!item.locked && inside(path.resolve(worktreesRoot), path.resolve(item.path)) && !await exists(item.path)) missing.push(item.path);
    }
    if (!missing.length) return {pruned: 0, reason: ''};
    const common = path.resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).trim());
    const admin = path.join(common, 'worktrees');
    let pruned = 0;
    for (const name of await readdir(admin)) {
      let recorded: string;
      try { recorded = (await readFile(path.join(admin, name, 'gitdir'), 'utf8')).trim(); } catch { continue; }
      // `gitdir` holds `<worktree>/.git`, so the worktree is its parent.
      if (!missing.some(target => samePath(path.dirname(recorded), target))) continue;
      await rm(path.join(admin, name), {recursive: true, force: true});
      pruned++;
    }
    return {pruned, reason: ''};
  } catch (error) {
    return {pruned: 0, reason: error instanceof Error ? error.message : 'could not prune worktree records'};
  }
}

function normalizeOwn(own: string): string {
  return path.posix.normalize(own.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
}
function isOwned(relative: string, owns: string[]): boolean {
  return owns.some(own => relative === own || relative.startsWith(`${own}/`));
}

/** Compare the real diff with the declared ownership list. Any file outside it must be reviewed before merging. */
export async function inspectScope(worktree: Worktree, owns: string[]): Promise<ScopeReport> {
  const report = await workspaceChanges(worktree.workspace);
  if (!report.available) return {checked: false, reason: report.reason ?? 'Could not read the worktree diff', changed: 0, out_of_scope: [], truncated: false};
  const paths = [...report.changes.map(change => change.path), ...report.untracked.map(item => item.path)];
  const relative = paths.map(value => worktree.prefix && value.startsWith(`${worktree.prefix}/`) ? value.slice(worktree.prefix.length + 1) : value);
  const normalizedOwns = owns.map(normalizeOwn);
  const outOfScope = [...new Set(relative.filter(value => !isOwned(value, normalizedOwns)))].sort();
  return {checked: true, changed: relative.length, out_of_scope: outOfScope, truncated: report.truncated};
}
