import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../src/paths.js';

export type Client = 'codex' | 'claude' | 'both';
const skillSource = (name: string, directory = paths.skillsDirectory) => path.join(directory, name, 'SKILL.md');
const skillFile = (root: string, client: 'codex' | 'claude', name: string) => path.join(root, client === 'codex' ? '.agents' : '.claude', 'skills', name, 'SKILL.md');
const readIfPresent = (file: string) => readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });

/** One folder per skill under `skills/`, each holding its SKILL.md, so a new skill needs no change here. */
export async function packagedSkills(directory = paths.skillsDirectory): Promise<string[]> {
  const names = (await readdir(directory, {withFileTypes: true}).catch(() => []))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const present = await Promise.all(names.map(async name => (await readIfPresent(skillSource(name, directory)) === null ? null : name)));
  return present.filter((name): name is string => name !== null).sort();
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n');
/** Identity of a skill file's content, independent of line endings (a Windows checkout may turn LF into CRLF). */
export const skillHash = (text: string) => createHash('sha256').update(normalize(text)).digest('hex');

export type KnownVersions = Record<string, Set<string>>;
/** sha256 of every SKILL.md this project has shipped, listed per skill (skills/known-versions.json). A file that matches one is an old packaged copy, not the owner's edit. */
export async function knownSkillHashes(file = path.join(paths.skillsDirectory, 'known-versions.json')): Promise<KnownVersions> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {skills?: Record<string, {sha256?: unknown}[]>};
    const known: KnownVersions = {};
    for (const [name, entries] of Object.entries(parsed.skills ?? {}))
      known[name] = new Set((entries ?? []).map(entry => entry.sha256).filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)));
    return known;
  } catch { return {}; }
}
const hashesFor = (known: KnownVersions, skill: string) => known[skill] ?? new Set<string>();

export type SkillState = 'installed' | 'outdated' | 'missing' | 'different';
function classify(existing: string | null, content: string, known: Set<string>): SkillState {
  if (existing === null) return 'missing';
  const hash = skillHash(existing);
  if (hash === skillHash(content)) return 'installed';
  return known.has(hash) ? 'outdated' : 'different';
}

interface PackagedSkill { name: string; content: string }
async function skillSources(skills?: string[]): Promise<PackagedSkill[]> {
  const names = skills ?? await packagedSkills();
  if (!names.length) throw new Error('No skill was selected and this bridge ships none (expected skills/<name>/SKILL.md)');
  return Promise.all(names.map(async name => ({name, content: await readFile(skillSource(name), 'utf8')})));
}
/** One fingerprint for the packaged set, so "a newer skill ships" means any skill in it changed. */
const setHash = (sources: PackagedSkill[]) => skillHash(sources.map(source => `${source.name}:${skillHash(source.content)}`).join('\n'));

export interface SkillFileStatus { skill: string; file: string; state: SkillState }
/**
 * Where every packaged skill is (or would be) installed for the current user and what is there: `installed` (this version),
 * `outdated` (an older version this project shipped, safe to replace), `different` (not any shipped version: the owner's edit) or `missing`. Reads only.
 */
export async function skillStatus(options: {userHome?: string; known?: KnownVersions; skills?: string[]} = {}) {
  const sources = await skillSources(options.skills);
  const known = options.known ?? await knownSkillHashes();
  const root = options.userHome ?? homedir();
  const result: {currentHash: string; codex: SkillFileStatus[]; claude: SkillFileStatus[]} = {currentHash: setHash(sources), codex: [], claude: []};
  for (const client of ['codex', 'claude'] as const) {
    for (const source of sources) {
      const file = skillFile(root, client, source.name);
      result[client].push({skill: source.name, file, state: classify(await readIfPresent(file), source.content, hashesFor(known, source.name))});
    }
  }
  return result;
}

export interface InstallResult { skill: string; filename: string; unchanged: boolean; updated?: boolean }
export async function installSkill(options: {client: Client; project?: string; userHome?: string; update?: boolean; known?: KnownVersions; skills?: string[]}): Promise<InstallResult[]> {
  if (!['codex', 'claude', 'both'].includes(options.client)) throw new Error('--client must be codex, claude or both');
  const sources = await skillSources(options.skills);
  const known = options.known ?? await knownSkillHashes();
  let root = options.userHome ?? homedir();
  if (options.project !== undefined) {
    if (!path.isAbsolute(options.project)) throw new Error('--project must be an absolute path to an existing project');
    root = await realpath(options.project);
    if (!(await stat(root)).isDirectory()) throw new Error('--project must be a directory');
  }
  const clients = options.client === 'both' ? ['codex', 'claude'] : [options.client];
  const planned: InstallResult[] = [];
  const writes: {filename: string; content: string; replace: boolean}[] = [];
  // Decide for every destination before writing any. A file that is not one of our shipped versions is never overwritten.
  for (const client of clients) {
    for (const source of sources) {
      const filename = skillFile(root, client as 'codex' | 'claude', source.name);
      const state = classify(await readIfPresent(filename), source.content, hashesFor(known, source.name));
      if (state === 'installed') planned.push({skill: source.name, filename, unchanged: true});
      else if (state === 'missing') { planned.push({skill: source.name, filename, unchanged: false}); writes.push({filename, content: source.content, replace: false}); }
      else if (state === 'outdated') {
        if (!options.update) throw new Error(`Existing skill is an older packaged version; run again with --update to replace it: ${filename}`);
        planned.push({skill: source.name, filename, unchanged: false, updated: true});
        writes.push({filename, content: source.content, replace: true});
      } else throw new Error(`Existing skill differs from every packaged version (customized); review it or remove it first: ${filename}`);
    }
  }
  for (const item of writes) {
    await mkdir(path.dirname(item.filename), {recursive: true});
    if (!item.replace) { await writeFile(item.filename, item.content, {flag: 'wx'}); continue; }
    // Replace atomically so a crash never leaves a half-written skill.
    const temporary = `${item.filename}.${process.pid}.tmp`;
    try { await writeFile(temporary, item.content, {flag: 'wx'}); await rename(temporary, item.filename); }
    finally { await rm(temporary, {force: true}); }
  }
  return planned;
}

async function main(args: string[]) {
  const skills = await packagedSkills();
  if (args.includes('--help')) {
    console.log('npm run skill:install -- --client codex|claude|both [--skill <name>] [--project ABSOLUTE_PROJECT_PATH] [--update]');
    console.log(`Skills packaged with this bridge: ${skills.join(', ') || '(none)'}. Without --skill, every one of them is installed.`);
    console.log('Without --project, installs for the current user. Does not change MCP configuration or permissions.');
    console.log('--update replaces an installed copy only if it is an older version shipped by this project; a customized file is never overwritten.');
    return;
  }
  let client: Client | undefined;
  let project: string | undefined;
  let update = false;
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--client' && client === undefined && args[index + 1]) client = args[++index] as Client;
    else if (flag === '--project' && project === undefined && args[index + 1]) project = args[++index];
    else if (flag === '--skill' && !selected.includes(args[index + 1] ?? '') && args[index + 1]) selected.push(args[++index]);
    else if (flag === '--update' && !update) update = true;
    else throw new Error('Invalid arguments; run npm run skill:install -- --help');
  }
  if (!client) throw new Error('Choose --client codex, claude or both');
  for (const name of selected) if (!skills.includes(name)) throw new Error(`--skill must be one of the packaged skills: ${skills.join(', ')}`);
  const installed = await installSkill({client, project, update, skills: selected.length ? selected : undefined});
  for (const item of installed) console.log(`[skill] ${item.unchanged ? 'Already installed' : item.updated ? 'Updated' : 'Installed'}: ${item.filename}`);
  console.log('[skill] Reopen the client if the skill does not appear. MCP connection and workspace permissions are configured separately.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {console.error(`[skill] ${error instanceof Error ? error.message : 'Installation failed'}`);process.exitCode = 1;});
}
