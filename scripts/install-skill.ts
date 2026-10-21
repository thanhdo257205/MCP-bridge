import { readFile, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../src/paths.js';

export type Client = 'codex' | 'claude' | 'both';
const skillSource = () => path.join(paths.skillsDirectory, 'antigravity-bridge', 'SKILL.md');
const skillFile = (root: string, client: 'codex' | 'claude') => path.join(root, client === 'codex' ? '.agents' : '.claude', 'skills', 'antigravity-bridge', 'SKILL.md');

/** Where the skill is (or would be) installed for the current user, and whether the file there is ours, missing, or customized. Reads only. */
export async function skillStatus(options: {userHome?: string} = {}) {
  const content = await readFile(skillSource(), 'utf8');
  const root = options.userHome ?? homedir();
  const result = {} as Record<'codex' | 'claude', {state: 'installed' | 'missing' | 'different'; file: string}>;
  for (const client of ['codex', 'claude'] as const) {
    const file = skillFile(root, client);
    const existing = await readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    result[client] = {file, state: existing === null ? 'missing' : existing === content ? 'installed' : 'different'};
  }
  return result;
}

export async function installSkill(options: {client: Client; project?: string; userHome?: string}) {
  if (!['codex', 'claude', 'both'].includes(options.client)) throw new Error('--client must be codex, claude or both');
  const content = await readFile(skillSource(), 'utf8');
  let root = options.userHome ?? homedir();
  if (options.project !== undefined) {
    if (!path.isAbsolute(options.project)) throw new Error('--project must be an absolute path to an existing project');
    root = await realpath(options.project);
    if (!(await stat(root)).isDirectory()) throw new Error('--project must be a directory');
  }
  const clients = options.client === 'both' ? ['codex', 'claude'] : [options.client];
  const destinations = clients.map(client => skillFile(root, client as 'codex' | 'claude'));
  const planned = [];
  // Check all destinations first. Never overwrite a locally customized skill.
  for (const filename of destinations) {
    try {
      const existing = await readFile(filename, 'utf8');
      if (existing !== content) throw new Error(`Existing skill differs; review it before updating: ${filename}`);
      planned.push({filename, unchanged: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      planned.push({filename, unchanged: false});
    }
  }
  for (const item of planned) {
    if (item.unchanged) continue;
    await mkdir(path.dirname(item.filename), {recursive: true});
    await writeFile(item.filename, content, {flag: 'wx'});
  }
  return planned;
}

async function main(args: string[]) {
  if (args.includes('--help')) {
    console.log('npm run skill:install -- --client codex|claude|both [--project ABSOLUTE_PROJECT_PATH]');
    console.log('Without --project, installs for the current user. Does not change MCP configuration or permissions.');
    return;
  }
  let client: Client | undefined;
  let project: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--client' && client === undefined && args[index + 1]) client = args[++index] as Client;
    else if (flag === '--project' && project === undefined && args[index + 1]) project = args[++index];
    else throw new Error('Invalid arguments; run npm run skill:install -- --help');
  }
  if (!client) throw new Error('Choose --client codex, claude or both');
  const installed = await installSkill({client, project});
  for (const item of installed) console.log(`[skill] ${item.unchanged ? 'Already installed' : 'Installed'}: ${item.filename}`);
  console.log('[skill] Reopen the client if the skill does not appear. MCP connection and workspace permissions are configured separately.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {console.error(`[skill] ${error instanceof Error ? error.message : 'Installation failed'}`);process.exitCode = 1;});
}
