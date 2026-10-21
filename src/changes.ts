import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Change { path: string; status: 'modified' | 'deleted' | 'added' | 'type-changed'; added: number | null; deleted: number | null; }
export interface ChangesReport {
  available: boolean; reason?: string; head: string | null; toplevel?: string;
  changes: Change[]; untracked: {path: string; bytes: number | null}[]; truncated: boolean;
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_ENTRIES = 500;
const SAFE_CONFIG = /^core\.(autocrlf|eol|filemode|symlinks|ignorecase)$/;
const SAFE_VALUE = /^(true|false|input|lf|crlf|native)$/;

/**
 * Read-only summary of what changed in a workspace, safe to run on a repository an agent has been editing.
 *
 * Plain `git status` / `git diff` run commands that the repository itself configures (core.fsmonitor, filter.*.clean,
 * diff.*.textconv, ...) and an agent that can write files can plant them in .git/config. So the repository's config is
 * never loaded: the comparison runs in a throw-away bare git dir with an empty config that borrows only the repository's
 * object database (alternates), with the system/global config disabled. A few harmless line-ending/permission settings are
 * copied over, each validated against a fixed list of values, so results match what the owner sees.
 */
export async function workspaceChanges(workspace: string, options: {git?: string; timeoutMs?: number} = {}): Promise<ChangesReport> {
  const git = options.git ?? 'git';
  const timeout = options.timeoutMs ?? 20000;
  const sandbox = await mkdtemp(path.join(tmpdir(), 'bridge-changes-'));
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const hardened: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
    HOME: sandbox, USERPROFILE: sandbox, XDG_CONFIG_HOME: sandbox, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_ATTR_NOSYSTEM: '1'
  };
  const run = (args: string[], env: NodeJS.ProcessEnv, cwd: string) => new Promise<string>((resolve, reject) => {
    execFile(git, args, {env, cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true}, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error((stderr || error.message).trim().split('\n')[0].slice(0, 200)), {code: (error as NodeJS.ErrnoException).code}));
      else resolve(stdout);
    });
  });
  const none: ChangesReport = {available: false, head: null, changes: [], untracked: [], truncated: false};
  try {
    // Discovery only reads the repository's config; it executes nothing.
    let located: string;
    try { located = await run(['-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix'], hardened, workspace); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {...none, reason: 'git is not installed or not on PATH'};
      return {...none, reason: `Not a usable git repository: ${(error as Error).message}`};
    }
    // Line 4 is the workspace's own path inside the repository (empty at the top). Asking git avoids comparing two spellings of one path.
    const rows = located.split('\n').map(line => line.trim());
    const [toplevel, gitDir, commonDir] = rows.slice(0, 3).filter(Boolean).map(line => path.resolve(line));
    const prefix = (rows[3] ?? '').replace(/\/+$/, '');
    if (!toplevel || !gitDir || !commonDir) return {...none, reason: 'Could not locate the repository'};
    if (/[\n\r]/.test(commonDir)) return {...none, reason: 'Unsupported repository path'};

    let head: string | null = null;
    try { head = (await run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], hardened, toplevel)).trim() || null; } catch { head = null; }
    const base = head ?? EMPTY_TREE;

    // Copy only validated, non-executing settings so line endings and file modes compare like the real repository.
    const copied: string[] = [];
    try {
      const listing = await run(['config', '--local', '--get-regexp', '^core\\.(autocrlf|eol|filemode|symlinks|ignorecase)$'], hardened, toplevel);
      for (const line of listing.split('\n')) {
        const [key, value] = [line.slice(0, line.indexOf(' ')).toLowerCase(), line.slice(line.indexOf(' ') + 1).trim().toLowerCase()];
        if (SAFE_CONFIG.test(key) && SAFE_VALUE.test(value)) copied.push('-c', `${key}=${value}`);
      }
    } catch { /* no local settings */ }

    const gitdir = path.join(sandbox, 'g');
    await run(['init', '--quiet', '--bare', '--template=', gitdir], hardened, sandbox);
    await writeFile(path.join(gitdir, 'objects', 'info', 'alternates'), `${path.join(commonDir, 'objects')}\n`);
    const env = {...hardened, GIT_DIR: gitdir, GIT_WORK_TREE: toplevel, GIT_INDEX_FILE: path.join(sandbox, 'index')};
    const g = (args: string[]) => run([...copied, ...args], env, toplevel);
    const scope = prefix && !prefix.startsWith('..') ? ['--', prefix] : [];

    await g(['read-tree', base]);
    // The fresh index has no stat data, so diff-index would call every file modified; refreshing compares real content
    // (exit status 1 only means "some files differ", which is exactly what is reported next).
    await g(['update-index', '-q', '--refresh', '--ignore-submodules']).catch(() => undefined);
    const diffArgs = ['diff-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '-z'];
    const [names, numbers] = await Promise.all([g([...diffArgs, '--name-status', base, ...scope]), g([...diffArgs, '--numstat', base, ...scope])]);
    const counts = new Map<string, {added: number | null; deleted: number | null}>();
    for (const record of numbers.split('\0').filter(Boolean)) {
      const [added, deleted, ...rest] = record.split('\t');
      counts.set(rest.join('\t'), {added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted)});
    }
    const kinds: Record<string, Change['status']> = {M: 'modified', D: 'deleted', A: 'added', T: 'type-changed'};
    const parts = names.split('\0').filter(Boolean);
    let changes: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      // The content diff (numstat) is authoritative: a file git lists only because its stat data differs, or because a
      // line-ending conversion makes the bytes differ but not the content, is not a change.
      const count = counts.get(parts[i + 1]);
      if (!count) continue;
      changes.push({path: parts[i + 1], status: kinds[parts[i][0]] ?? 'modified', added: count.added, deleted: count.deleted});
    }
    const excludeFile = path.join(commonDir, 'info', 'exclude');
    const exclude = await readFile(excludeFile).then(() => ['--exclude-from', excludeFile], () => []);
    const others = (await g(['ls-files', '--others', '--exclude-standard', ...exclude, '-z', ...scope])).split('\0').filter(Boolean);

    let truncated = false;
    if (changes.length > MAX_ENTRIES) { changes = changes.slice(0, MAX_ENTRIES); truncated = true; }
    if (others.length > MAX_ENTRIES) { others.length = MAX_ENTRIES; truncated = true; }
    const untracked = await Promise.all(others.map(async file => {
      const info = await lstat(path.join(toplevel, file)).catch(() => null);
      return {path: file, bytes: info && info.isFile() ? info.size : null};
    }));
    return {available: true, head, toplevel, changes, untracked, truncated};
  } catch (error) {
    return {...none, reason: `Could not read changes: ${error instanceof Error ? error.message : 'unknown error'}`};
  } finally {
    await rm(sandbox, {recursive: true, force: true}).catch(() => {});
  }
}
