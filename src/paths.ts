import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read-only assets shipped with the code (ui/, skills/, package.json). Two levels above dist/src. */
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Working directory for helper processes (`agy --version`, `--help`, `models`). Never the package directory: on Windows a process keeps its
 * working directory open, so a helper (or anything it leaves running) there would make `npm install -g` fail with EBUSY.
 */
export const helperDirectory = (): string => tmpdir();

export interface Paths {
  /** `checkout`: running from a git clone (state next to the code, as before). `installed`: running from node_modules (state in the user's data directory). */
  mode: 'checkout' | 'installed';
  packageRoot: string; dataDirectory: string; configFile: string; stateDirectory: string; resultsDirectory: string;
  uiDirectory: string; skillsDirectory: string;
}

/** Per-user, writable, survives package updates (an update replaces the whole install directory). */
export function userDataDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'agy-mcp-bridge');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'agy-mcp-bridge');
  return path.posix.join(env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config'), 'agy-mcp-bridge');
}

export function resolvePaths(options: {root?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string} = {}): Paths {
  const root = options.root ?? packageRoot;
  const env = options.env ?? process.env;
  const installed = root.split(/[\\/]/).includes('node_modules');
  const override = env.BRIDGE_HOME;
  if (override !== undefined && override !== '' && !path.isAbsolute(override)) throw new Error('BRIDGE_HOME must be an absolute path');
  const common = {packageRoot: root, uiDirectory: path.join(root, 'ui'), skillsDirectory: path.join(root, 'skills')};
  if (override || installed) {
    const data = override || userDataDirectory(env, options.platform, options.home);
    return {...common, mode: installed ? 'installed' : 'checkout', dataDirectory: data, configFile: path.join(data, 'workspaces.json'),
      stateDirectory: path.join(data, 'state'), resultsDirectory: path.join(data, 'results')};
  }
  return {...common, mode: 'checkout', dataDirectory: root, configFile: path.join(root, 'config', 'workspaces.json'),
    stateDirectory: path.join(root, '.bridge-state'), resultsDirectory: path.join(root, 'test-results')};
}

export const paths = resolvePaths();
