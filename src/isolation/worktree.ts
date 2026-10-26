import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
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

/** Best effort and only for a launch that never started a process: no files were touched by the agent. */
export async function removeWorktree(worktree: Worktree): Promise<void> {
  await git(worktree.toplevel, ['worktree', 'remove', '--force', worktree.root]).catch(() => {});
  await git(worktree.toplevel, ['branch', '-D', worktree.branch]).catch(() => {});
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
