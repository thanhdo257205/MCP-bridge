import { execFile } from 'node:child_process';
import path from 'node:path';
import { redact } from '../security/redact.js';
import { gitEnvironment } from './apply.js';

/**
 * The content diff of one file in a task's worktree, for the owner to read before applying it. Read only: nothing is staged or written
 * (`git add` would race with an agent that is still running), and the worktree is bridge-owned, so its files are not the owner's.
 * Secrets are filtered the way task logs are.
 */
const MAX_DIFF_CHARS = 200_000;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface FileDiff {
  path: string;
  /** Unified diff against the commit the worktree was made from; empty when the file has no change. */
  diff: string;
  truncated: boolean;
  binary: boolean;
  changed: boolean;
}

/** A path inside the worktree, as the changes list reports it: relative, no drive, no `..`, no empty segment. */
export function isRelativeFilePath(file: unknown): file is string {
  if (typeof file !== 'string' || !file || file.length > 512 || file.includes('\0')) return false;
  if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.startsWith('/') || file.startsWith('\\')) return false;
  return !file.replace(/\\/g, '/').split('/').some(part => part === '' || part === '..');
}

interface Captured { stdout: string; code: number | null; overflow: boolean }

function capture(cwd: string, args: string[]): Promise<Captured> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], {cwd, env: gitEnvironment(), timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true},
      (error, stdout) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as NodeJS.ErrnoException).code as unknown as number : null) : 0;
        resolve({stdout: stdout ?? '', code, overflow: Boolean(error) && /maxBuffer/i.test(error!.message)});
      });
  });
}

export async function worktreeFileDiff(worktree: string, file: string): Promise<FileDiff> {
  if (!isRelativeFilePath(file)) throw new Error('path must be a relative path inside the worktree');
  const literal = `:(literal)${file}`;
  // Tracked files diff against the base commit; a file the agent created is not in the index, so it is shown as all added lines.
  const tracked = (await capture(worktree, ['ls-files', '--error-unmatch', '-z', '--', literal])).code === 0;
  const result = tracked
    ? await capture(worktree, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--', literal])
    : await capture(worktree, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', NULL_DEVICE, file]);
  // `git diff --no-index` exits 1 when the files differ; 128 means the file is not there at all.
  if (!result.stdout && !result.overflow) return {path: file, diff: '', truncated: false, binary: false, changed: false};
  const truncated = result.overflow || result.stdout.length > MAX_DIFF_CHARS;
  const text = redact(result.stdout.slice(0, MAX_DIFF_CHARS));
  return {path: file, diff: text, truncated, binary: /^Binary files .* differ$/m.test(text), changed: true};
}
