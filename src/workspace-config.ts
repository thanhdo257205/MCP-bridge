import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inside } from './security/workspace.js';

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('config must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {allowed_workspaces: []};
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
  }
}
const entries = (config: Record<string, unknown>): string[] => {
  const value = config.allowed_workspaces;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('allowed_workspaces must be an array of strings');
  return value as string[];
};
async function save(file: string, config: Record<string, unknown>) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

export async function listWorkspaces(file: string): Promise<string[]> { return entries(await readConfig(file)); }

/** Real path of an existing directory an agent may be allowed to edit. Refuses the bridge's own source tree. */
export async function resolveWorkspaceDirectory(input: string, bridgeRoot: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Workspace must be an absolute path');
  const canonical = await realpath(input).catch(() => { throw new Error(`Directory does not exist: ${input}`); });
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${canonical}`);
  const own = await realpath(bridgeRoot);
  if (inside(own, canonical) || inside(canonical, own)) throw new Error('Refusing a workspace that contains or lies inside the bridge installation itself');
  return canonical;
}

/** Adds an existing directory (stored as its real path). */
export async function addWorkspace(file: string, input: string, bridgeRoot: string): Promise<{added: boolean; path: string}> {
  const canonical = await resolveWorkspaceDirectory(input, bridgeRoot);
  const config = await readConfig(file);
  const current = entries(config);
  if (current.includes(canonical)) return {added: false, path: canonical};
  await save(file, {...config, allowed_workspaces: [...current, canonical]});
  return {added: true, path: canonical};
}

export async function removeWorkspace(file: string, input: string): Promise<{removed: boolean}> {
  const config = await readConfig(file);
  const current = entries(config);
  const real = await realpath(input).catch(() => input);
  const next = current.filter(item => item !== input && item !== real);
  if (next.length === current.length) return {removed: false};
  await save(file, {...config, allowed_workspaces: next});
  return {removed: true};
}
