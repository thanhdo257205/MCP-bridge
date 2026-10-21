import { realpath, stat, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Dependency and Git internals are excluded. Other links must resolve inside the workspace.
// This is a preflight check; it cannot prevent a concurrent link swap by another process.
export async function validateWorkspace(input: string, allowlist: string[]): Promise<string> {
  if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Workspace must be an absolute path');
  const canonical = await realpath(input);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace is not a directory');
  const roots = await Promise.all(allowlist.map(async root => {
    if (!path.isAbsolute(root)) throw new Error('Allowlist entries must be absolute');
    return realpath(root);
  }));
  if (!roots.some(root => inside(root, canonical))) throw new Error('Workspace is outside the allowlist');
  // Disallow aliasing through a link in any input path component, even one pointing inward.
  let current = path.parse(path.resolve(input)).root;
  for (const part of path.resolve(input).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Workspace path contains a symlink or junction');
  }
  let visited = 0;
  const stack = [canonical];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue;
      if (++visited > 200000) throw new Error('Workspace preflight exceeds 200000 entries');
      if (info.isSymbolicLink()) {
        const target = await realpath(filename).catch(() => { throw new Error('Workspace contains an unresolved symlink or junction'); });
        if (!inside(canonical, target)) throw new Error('Workspace contains a symlink or junction pointing outside the workspace');
        continue; // Do not follow aliases/cycles; their real in-tree targets are scanned normally.
      }
      if (info.isDirectory()) stack.push(filename);
    }
  }
  return canonical;
}
