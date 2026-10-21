import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../src/paths.js';

export type Client = 'codex' | 'claude' | 'both';
const skillSource = () => path.join(paths.skillsDirectory, 'antigravity-bridge', 'SKILL.md');
const skillFile = (root: string, client: 'codex' | 'claude') => path.join(root, client === 'codex' ? '.agents' : '.claude', 'skills', 'antigravity-bridge', 'SKILL.md');

const normalize = (text: string) => text.replace(/\r\n/g, '\n');
/** Identity of a skill file's content, independent of line endings (a Windows checkout may turn LF into CRLF). */
export const skillHash = (text: string) => createHash('sha256').update(normalize(text)).digest('hex');

/** sha256 of every SKILL.md this project has shipped (skills/known-versions.json). A file that matches one is an old packaged copy, not the owner's edit. */
export async function knownSkillHashes(file = path.join(paths.skillsDirectory, 'known-versions.json')): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {versions?: {sha256?: unknown}[]};
    return new Set((parsed.versions ?? []).map(entry => entry.sha256).filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)));
  } catch { return new Set(); }
}

export type SkillState = 'installed' | 'outdated' | 'missing' | 'different';
function classify(existing: string | null, content: string, known: Set<string>): SkillState {
  if (existing === null) return 'missing';
  const hash = skillHash(existing);
  if (hash === skillHash(content)) return 'installed';
  return known.has(hash) ? 'outdated' : 'different';
}
const readIfPresent = (file: string) => readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });

/**
 * Where the skill is (or would be) installed for the current user and what is there: `installed` (this version), `outdated`
 * (an older version this project shipped, safe to replace), `different` (not any shipped version: the owner's edit) or `missing`. Reads only.
 */
export async function skillStatus(options: {userHome?: string; known?: Set<string>} = {}) {
  const content = await readFile(skillSource(), 'utf8');
  const known = options.known ?? await knownSkillHashes();
  const root = options.userHome ?? homedir();
  const result = {currentHash: skillHash(content)} as Record<'codex' | 'claude', {state: SkillState; file: string}> & {currentHash: string};
  for (const client of ['codex', 'claude'] as const) {
    const file = skillFile(root, client);
    result[client] = {file, state: classify(await readIfPresent(file), content, known)};
  }
  return result;
}

export interface InstallResult { filename: string; unchanged: boolean; updated?: boolean }
export async function installSkill(options: {client: Client; project?: string; userHome?: string; update?: boolean; known?: Set<string>}): Promise<InstallResult[]> {
  if (!['codex', 'claude', 'both'].includes(options.client)) throw new Error('--client must be codex, claude or both');
  const content = await readFile(skillSource(), 'utf8');
  const known = options.known ?? await knownSkillHashes();
  let root = options.userHome ?? homedir();
  if (options.project !== undefined) {
    if (!path.isAbsolute(options.project)) throw new Error('--project must be an absolute path to an existing project');
    root = await realpath(options.project);
    if (!(await stat(root)).isDirectory()) throw new Error('--project must be a directory');
  }
  const clients = options.client === 'both' ? ['codex', 'claude'] : [options.client];
  const destinations = clients.map(client => skillFile(root, client as 'codex' | 'claude'));
  const planned: InstallResult[] = [];
  // Decide for every destination before writing any. A file that is not one of our shipped versions is never overwritten.
  for (const filename of destinations) {
    const state = classify(await readIfPresent(filename), content, known);
    if (state === 'installed') planned.push({filename, unchanged: true});
    else if (state === 'missing') planned.push({filename, unchanged: false});
    else if (state === 'outdated') {
      if (!options.update) throw new Error(`Existing skill is an older packaged version; run again with --update to replace it: ${filename}`);
      planned.push({filename, unchanged: false, updated: true});
    } else throw new Error(`Existing skill differs from every packaged version (customized); review it or remove it first: ${filename}`);
  }
  for (const item of planned) {
    if (item.unchanged) continue;
    await mkdir(path.dirname(item.filename), {recursive: true});
    if (!item.updated) { await writeFile(item.filename, content, {flag: 'wx'}); continue; }
    // Replace atomically so a crash never leaves a half-written skill.
    const temporary = `${item.filename}.${process.pid}.tmp`;
    try { await writeFile(temporary, content, {flag: 'wx'}); await rename(temporary, item.filename); }
    finally { await rm(temporary, {force: true}); }
  }
  return planned;
}

async function main(args: string[]) {
  if (args.includes('--help')) {
    console.log('npm run skill:install -- --client codex|claude|both [--project ABSOLUTE_PROJECT_PATH] [--update]');
    console.log('Without --project, installs for the current user. Does not change MCP configuration or permissions.');
    console.log('--update replaces an installed copy only if it is an older version shipped by this project; a customized file is never overwritten.');
    return;
  }
  let client: Client | undefined;
  let project: string | undefined;
  let update = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--client' && client === undefined && args[index + 1]) client = args[++index] as Client;
    else if (flag === '--project' && project === undefined && args[index + 1]) project = args[++index];
    else if (flag === '--update' && !update) update = true;
    else throw new Error('Invalid arguments; run npm run skill:install -- --help');
  }
  if (!client) throw new Error('Choose --client codex, claude or both');
  const installed = await installSkill({client, project, update});
  for (const item of installed) console.log(`[skill] ${item.unchanged ? 'Already installed' : item.updated ? 'Updated' : 'Installed'}: ${item.filename}`);
  console.log('[skill] Reopen the client if the skill does not appear. MCP connection and workspace permissions are configured separately.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {console.error(`[skill] ${error instanceof Error ? error.message : 'Installation failed'}`);process.exitCode = 1;});
}
