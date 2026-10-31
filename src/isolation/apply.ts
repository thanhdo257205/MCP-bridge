import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { inside } from '../security/workspace.js';
import { isOwned, normalizeOwn } from './worktree.js';

/**
 * Brings a finished worktree task's changes into the original workspace as plain, uncommitted edits.
 *
 * Deliberately not a branch merge: nothing is committed on the owner's behalf, no branch is switched, and the owner reviews and
 * commits (or `git restore`s) what arrives. The patch is built from the worktree, checked against the workspace first, and only
 * then applied, so a workspace that moved on since the task started is refused instead of half-written.
 */
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;

export interface ApplyInput {
  /** Root of the task's worktree (a checkout of the same repository). */
  worktree: string;
  /** Repository root both checkouts belong to. */
  toplevel: string;
  /** The directory the task was delegated in (may be a subdirectory of the repository). */
  workspace: string;
  /** Paths the task was allowed to change, relative to `workspace`. */
  owns: string[];
}

export type ApplyResult = {applied: true; files: string[]; patch_bytes: number} | {applied: false; reason: string};

export const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
  TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C'
});

class Refusal extends Error {}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
      {cwd, env: gitEnvironment(), timeout: 30000, maxBuffer: MAX_PATCH_BYTES + 1024, encoding: 'utf8', windowsHide: true},
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim().split('\n')[0].slice(0, 300)));
        else resolve(stdout);
      });
    // A git that exits before reading its input (a bad patch) closes the pipe; that is reported through the exit status, not as a crash.
    child.stdin?.on('error', () => undefined);
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The directory's path inside the repository, forward slashes, no trailing slash ('' at the top). */
async function prefixOf(toplevel: string, workspace: string): Promise<string> {
  const [top, work] = await Promise.all([realpath(toplevel), realpath(workspace)]);
  if (!inside(top, work)) throw new Refusal('The workspace is not inside the repository the worktree was made from');
  return path.relative(top, work).split(path.sep).join('/');
}

/** The repository root of a directory, as an absolute canonical path. */
export async function repositoryRoot(directory: string): Promise<string> {
  try { return await realpath((await git(directory, ['rev-parse', '--show-toplevel'])).trim()); }
  catch (error) { throw new Error('The workspace is not a git repository: ' + (error instanceof Error ? error.message : 'git failed')); }
}

const literal = (file: string) => `:(literal)${file}`;

export async function applyWorktreeChanges(input: ApplyInput): Promise<ApplyResult> {
  try {
    const prefix = await prefixOf(input.toplevel, input.workspace);
    const scope = prefix ? [prefix] : ['.'];
    const owns = input.owns.map(normalizeOwn);
    if (!owns.length) throw new Refusal('The task declared no owned paths, so there is nothing it was allowed to change');

    // Staging is only a way to include new files in the diff: it touches the worktree's own index, never the workspace.
    await git(input.worktree, ['add', '-A', '--', ...scope]);
    const names = (await git(input.worktree, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--', ...scope])).split('\0').filter(Boolean);
    if (!names.length) throw new Refusal('The worktree has no changes to apply');
    if (names.length > MAX_FILES) throw new Refusal(`The worktree changes ${names.length} files; apply is limited to ${MAX_FILES}`);
    const relative = names.map(name => prefix && name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : name);
    const outside = relative.filter(name => !isOwned(name, owns));
    if (outside.length) throw new Refusal(`Files outside the task's owned paths were changed (${outside.slice(0, 5).join(', ')}); review them in the worktree`);

    // A symlink or a submodule pointer is more than text: it can point outside the workspace, so it is never applied from here.
    const raw = (await git(input.worktree, ['diff', '--cached', '--raw', '-z', 'HEAD', '--', ...scope])).split('\0');
    if (raw.some(field => /^:(?:12|16)0000 /.test(field) || /^:\d+ (?:12|16)0000 /.test(field))) throw new Refusal('The change includes a symlink or a submodule, which is not applied from here; review it in the worktree');

    const patch = await git(input.worktree, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...scope]);
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Refusal('The change is larger than the apply limit; review it in the worktree');

    // A file the owner is editing right now is theirs to merge by hand, even if the patch would happen to fit.
    const dirty = (await git(input.toplevel, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...names.map(literal)])).split('\0').filter(Boolean);
    if (dirty.length) throw new Refusal(`The workspace already has uncommitted changes in: ${dirty.slice(0, 5).map(line => line.slice(3)).join(', ')}`);

    try { await git(input.toplevel, ['apply', '--check', '--whitespace=nowarn', '-'], patch); }
    catch (error) { throw new Refusal(`The changes no longer fit the workspace: ${error instanceof Error ? error.message : 'git apply --check failed'}`); }
    await git(input.toplevel, ['apply', '--whitespace=nowarn', '-'], patch);
    return {applied: true, files: relative.sort(), patch_bytes: Buffer.byteLength(patch)};
  } catch (error) {
    return {applied: false, reason: error instanceof Error ? error.message : 'Apply failed'};
  }
}
