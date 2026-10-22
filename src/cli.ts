#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { paths } from './paths.js';
import { existsSync } from 'node:fs';
import { addSessionWorkspaces } from './config.js';
import { recoverExecutionLock } from './tasks/execution-lock.js';
import { renderSetup, type Client, type Shell } from './setup.js';
import { readWait } from './wait-setting.js';
import { configuredPort } from './http.js';
import { offerSkillInstall, offerSkillUpdate } from './onboarding.js';
import { addWorkspace, listWorkspaces, removeWorkspace, resolveWorkspaceDirectory } from './workspace-config.js';
import {
  checkForUpdate, compareVersions, fetchLatest, installFailureHint, isGlobalInstall, isSnoozed, readPackageInfo, runGlobalInstall, snooze, updateCheckEnabled, type UpdateInfo
} from './update.js';

const BIN = 'agy-mcp-bridge';
const pkg = readPackageInfo();
const configFile = process.env.ANTIGRAVITY_BRIDGE_CONFIG ?? paths.configFile;
const HELP = `${BIN} ${pkg.version}: local MCP bridge from Codex / Claude Code to the Antigravity CLI (agy)

Usage: ${BIN} [command] [options]

  start (default)         Run the HTTP server (default http://127.0.0.1:3000, web UI at /ui)
      --port <0-65535>      Port to listen on (same as the PORT variable)
      --workspace <dir>     Also allow <dir> (for example .) for this run only; repeatable, not saved
      --open                Open the web UI in your default browser once the server is up
      --no-update-check     Do not ask the npm registry whether a newer version exists
      --show-token          Print the web UI login token in this terminal (interactive terminals only; it is also shown once
                            automatically the first time the token is created)
      --no-skill-prompt     Do not offer to install the Codex / Claude Code skill on first run
  check                   Call antigravity_environment on the running server
  workspaces list|add <dir>|remove <dir>
                          Manage the directories agents may edit (restart the server afterwards)
  delegation on|off|status
                          Switch delegation to Antigravity on or off immediately (no restart)
  skill install --client codex|claude|both [--project <dir>] [--update]
                          Install the antigravity-bridge skill (first run also offers it once). --update replaces an older
                          packaged copy; a file you edited yourself is never overwritten
  setup codex|claude|both [--port N] [--shell powershell|cmd|bash]
                          Print the exact client configuration and token commands (changes nothing)
  config [--json]         Show where config, state and the token file live (never prints the token)
  update [--check]        Install the newest version from npm (only for a global install); --check only reports
  unlock                 Reclaim a lock only when both recorded server and child PIDs are dead
  probe-stream            Capture the real agy stream-json event shape (one tiny AI call)
  version, help

Environment: BRIDGE_HOME (data directory), PORT, BRIDGE_HTTP_TOKEN, BRIDGE_DELEGATION=off,
BRIDGE_NO_UPDATE_CHECK=1, ANTIGRAVITY_BRIDGE_CONFIG. Details: README.md in ${paths.packageRoot}`;

function runScript(script: string, args: string[]): never {
  const result = spawnSync(process.execPath, [path.join(paths.packageRoot, 'dist', 'scripts', script), ...args], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}

function describeConfig() {
  return {
    package: pkg.name, version: pkg.version, mode: paths.mode, package_directory: paths.packageRoot, data_directory: paths.dataDirectory,
    config_file: configFile, state_directory: paths.stateDirectory, token_file: path.join(paths.stateDirectory, 'http-token'),
    update_check: updateCheckEnabled(paths.mode) ? 'enabled' : 'disabled'
  };
}

async function offerUpdate(info: UpdateInfo) {
  const notice = `[update] ${pkg.name} ${info.latest} is available (you have ${info.current}).`;
  if (!(await isGlobalInstall())) {
    console.error(`${notice} This is not a global npm install; update it the way you installed it (for example: npm install -g ${pkg.name}@latest, or npx ${pkg.name}@latest).`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error(`${notice} Run: ${BIN} update`); return; }
  if (await isSnoozed(paths.stateDirectory, info.latest)) { console.error(`${notice} Run: ${BIN} update`); return; }
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = (await rl.question(`${notice}\nUpdate now with "npm install -g ${pkg.name}@${info.latest}"? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') { await snooze(paths.stateDirectory, info.latest); console.error('[update] Skipped; will ask again about this version tomorrow. Starting the current version.'); return; }
  } finally { rl.close(); }
  if (runGlobalInstall(pkg.name, info.latest) === 0) {
    console.error(`[update] Installed ${info.latest}. Start the bridge again to use it: ${BIN}`);
    process.exit(0);
  }
  console.error(`[update] Installation failed (see npm output above). Starting the current version ${info.current}.`);
  const hint = installFailureHint(pkg.name);
  if (hint) console.error(`[update] ${hint}`);
}

async function start(args: string[]) {
  const directories: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1] !== undefined) process.env.PORT = args[++i];
    else if (args[i] === '--workspace' && args[i + 1] !== undefined) directories.push(path.resolve(args[++i]));
    else if (args[i] === '--no-update-check') process.env.BRIDGE_NO_UPDATE_CHECK = '1';
    else if (args[i] === '--no-skill-prompt') process.env.BRIDGE_NO_SKILL_PROMPT = '1';
    else if (args[i] === '--show-token') process.env.BRIDGE_SHOW_TOKEN = '1';
    else if (args[i] === '--open') process.env.BRIDGE_OPEN_BROWSER = '1';
    else if (args[i] === '--port' || args[i] === '--workspace') throw new Error(`${args[i]} needs a value (see ${BIN} help)`);
    else throw new Error(`Unknown option for start: ${args[i]} (see ${BIN} help)`);
  }
  // Validated before anything starts, so a typo never leaves a server running with the wrong access.
  const allowed = await Promise.all(directories.map(directory => resolveWorkspaceDirectory(directory, paths.packageRoot)));
  addSessionWorkspaces(allowed);
  for (const directory of allowed) console.error(`[${BIN}] Workspace allowed for this run only (not saved): ${directory}`);
  if (updateCheckEnabled(paths.mode)) {
    const info = await checkForUpdate({stateDirectory: paths.stateDirectory, pkg});
    if (info) await offerUpdate(info);
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    try {
      const offer = {stateDirectory: paths.stateDirectory, interactive, ask: (question: string) => rl.question(question)};
      await offerSkillInstall(offer);
      await offerSkillUpdate(offer);
    }
    finally { rl.close(); }
  }
  await import('./index.js');
}

async function updateCommand(args: string[]) {
  const checkOnly = args.includes('--check');
  if (args.some(arg => arg !== '--check')) throw new Error(`Usage: ${BIN} update [--check]`);
  const latest = await fetchLatest(pkg.name, {registry: process.env.BRIDGE_UPDATE_REGISTRY});
  if (!latest) throw new Error(`Could not look up the latest version of ${pkg.name} (registry unreachable, or the package is not published yet)`);
  if (compareVersions(latest, pkg.version) <= 0) { console.log(`${pkg.name} ${pkg.version} is up to date.`); return; }
  console.log(`${pkg.name} ${latest} is available (you have ${pkg.version}).`);
  if (checkOnly) return;
  if (paths.mode !== 'installed' || !(await isGlobalInstall())) {
    console.log(paths.mode === 'checkout' ? 'This is a git checkout: run git pull, then npm ci && npm run build.'
      : `This is not a global npm install; update it the way you installed it (for example: npm install ${pkg.name}@latest in that project).`);
    process.exitCode = 1; return;
  }
  const status = runGlobalInstall(pkg.name, latest);
  if (status === 0) console.log(`Updated to ${latest}. Restart a running server (Ctrl+C, then ${BIN}) to use it.`);
  else { const hint = installFailureHint(pkg.name); if (hint) console.error(hint); }
  process.exitCode = status;
}

function setup(args: string[]) {
  const target = args[0];
  if (target !== 'codex' && target !== 'claude' && target !== 'both') throw new Error(`Usage: ${BIN} setup codex|claude|both [--port N] [--shell powershell|cmd|bash]`);
  let port = process.env.PORT !== undefined && process.env.PORT !== '0' ? configuredPort(process.env.PORT) : 3000;
  let shell: Shell[] = process.platform === 'win32' ? ['powershell', 'cmd'] : ['bash'];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1] !== undefined) port = configuredPort(args[++i]);
    else if (args[i] === '--shell' && args[i + 1] !== undefined) {
      const chosen = args[++i];
      if (chosen !== 'powershell' && chosen !== 'cmd' && chosen !== 'bash') throw new Error('--shell must be powershell, cmd or bash');
      shell = [chosen];
    } else throw new Error(`Unknown option for setup: ${args[i]}`);
  }
  if (port === 0) throw new Error('Give a fixed port: --port 3000 (0 picks a different port every run, so a client could not be configured)');
  const tokenFile = path.join(paths.stateDirectory, 'http-token');
  const clients: Client[] = target === 'both' ? ['codex', 'claude'] : [target];
  console.log(renderSetup({clients, mcpUrl: `http://127.0.0.1:${port}/mcp`, tokenFile, tokenFileExists: existsSync(tokenFile), tokenFromEnv: Boolean(process.env.BRIDGE_HTTP_TOKEN), shells: shell, bin: BIN, waitSeconds: readWait(paths.stateDirectory) ?? undefined}));
}

async function workspaces(args: string[]) {
  const [action, target] = args;
  if (action === 'list' && target === undefined) {
    const list = await listWorkspaces(configFile);
    console.log(list.length ? list.join('\n') : `(none) Add one with: ${BIN} workspaces add <absolute-directory>`);
  } else if (action === 'add' && target) {
    const result = await addWorkspace(configFile, path.resolve(target), paths.packageRoot);
    console.log(`${result.added ? 'Added' : 'Already allowed'}: ${result.path}\nRestart the server for the change to take effect. Config: ${configFile}`);
  } else if (action === 'remove' && target) {
    console.log((await removeWorkspace(configFile, path.resolve(target))).removed ? 'Removed. Restart the server for the change to take effect.' : 'Not in the allowlist.');
  } else throw new Error(`Usage: ${BIN} workspaces list | add <dir> | remove <dir>`);
}

async function main(argv: string[]) {
  const first = argv[0];
  if (first === '--version' || first === '-v' || first === 'version') { console.log(pkg.version); return; }
  if (first === '--help' || first === '-h' || first === 'help') { console.log(HELP); return; }
  const command = first && !first.startsWith('-') ? first : 'start';
  const rest = command === first ? argv.slice(1) : argv;
  switch (command) {
    case 'start': return start(rest);
    case 'check': return runScript('check.js', rest);
    case 'delegation': return runScript('delegation.js', rest);
    case 'probe-stream': return runScript('probe-stream.js', rest);
    case 'skill':
      if (rest[0] !== 'install') throw new Error(`Usage: ${BIN} skill install --client codex|claude|both [--project <dir>]`);
      return runScript('install-skill.js', rest.slice(1));
    case 'config': {
      const info = describeConfig();
      if (rest.includes('--json')) console.log(JSON.stringify(info, null, 2));
      else for (const [key, value] of Object.entries(info)) console.log(`${key.replace(/_/g, ' ')}: ${value}`);
      return;
    }
    case 'setup': return setup(rest);
    case 'workspaces': return workspaces(rest);
    case 'update': return updateCommand(rest);
    case 'unlock': {
      if(rest.length)throw new Error(`Usage: ${BIN} unlock`);
      const result=await recoverExecutionLock(paths.stateDirectory);
      console.log(result.reason);if(!result.reclaimed&&!result.absent)process.exitCode=1;
      return;
    }
    default: throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

// A global install runs this file through a symlink, so compare real paths.
const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedDirectly) {
  main(process.argv.slice(2)).catch(error => { console.error(`[${BIN}] ${error instanceof Error ? error.message : 'Command failed'}`); process.exitCode = 1; });
}
