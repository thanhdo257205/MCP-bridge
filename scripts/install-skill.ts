import { readFile, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Client = 'codex' | 'claude' | 'both';
export async function installSkill(options: {client: Client; project?: string; userHome?: string}) {
  if (!['codex', 'claude', 'both'].includes(options.client)) throw new Error('--client must be codex, claude or both');
  const source = fileURLToPath(new URL('../../skills/antigravity-bridge/SKILL.md', import.meta.url));
  const content = await readFile(source, 'utf8');
  let root = options.userHome ?? homedir();
  if (options.project !== undefined) {
    if (!path.isAbsolute(options.project)) throw new Error('--project must be an absolute path to an existing project');
    root = await realpath(options.project);
    if (!(await stat(root)).isDirectory()) throw new Error('--project must be a directory');
  }
  const clients = options.client === 'both' ? ['codex', 'claude'] : [options.client];
  const destinations = clients.map(client => path.join(root, client === 'codex' ? '.agents' : '.claude', 'skills', 'antigravity-bridge', 'SKILL.md'));
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
