import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { paths, type Paths } from './paths.js';

export interface PackageInfo { name: string; version: string; }
export interface UpdateInfo { current: string; latest: string; }
interface Cache { checked_at?: string; latest?: string; snoozed_version?: string; snoozed_until?: string; }

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

const packageInfo = new Map<string, PackageInfo>();
/** The manifest never changes while the process runs, and this is called per MCP request and per UI poll, so read it once. */
export function readPackageInfo(root = paths.packageRoot): PackageInfo {
  const cached = packageInfo.get(root);
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Partial<PackageInfo>;
  const info = {name: String(parsed.name), version: String(parsed.version)};
  packageInfo.set(root, info);
  return info;
}

/** Numeric semver compare; a prerelease sorts before the same release. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const withoutBuild=value.split('+')[0],dash=withoutBuild.indexOf('-');
    const core=dash<0?withoutBuild:withoutBuild.slice(0,dash);
    return {nums:core.split('.').map(BigInt),pre:dash<0?undefined:withoutBuild.slice(dash+1)};
  };
  const x = split(a); const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]<y.nums[i]?-1:1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const left=x.pre.split('.'),right=y.pre.split('.');
  for(let i=0;i<Math.max(left.length,right.length);i++){
    if(left[i]===undefined)return -1;
    if(right[i]===undefined)return 1;
    if(left[i]===right[i])continue;
    const aNumeric=/^\d+$/.test(left[i]),bNumeric=/^\d+$/.test(right[i]);
    if(aNumeric&&bNumeric){const aValue=BigInt(left[i]),bValue=BigInt(right[i]);if(aValue===bValue)continue;return aValue<bValue?-1:1;}
    if(aNumeric!==bNumeric)return aNumeric?-1:1;
    return left[i]<right[i]?-1:1;
  }
  return 0;
}

/** Off in CI and whenever the owner opts out (the opt-out always wins). Otherwise on for an npm install and off for a git checkout (use git pull); BRIDGE_UPDATE_CHECK=force turns it on for a checkout, for tests and development. */
export function updateCheckEnabled(mode: Paths['mode'], env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(1|true|yes)$/i.test(env.BRIDGE_NO_UPDATE_CHECK ?? '') || /^(1|true)$/i.test(env.CI ?? '')) return false;
  return mode === 'installed' || env.BRIDGE_UPDATE_CHECK === 'force';
}

export async function fetchLatest(name: string, options: {registry?: string; timeoutMs?: number; fetchImpl?: typeof fetch} = {}): Promise<string | null> {
  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  try {
    const response = await (options.fetchImpl ?? fetch)(`${registry}/${encodeURIComponent(name).replace('%40', '@')}/latest`, {
      headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(options.timeoutMs ?? 3000)
    });
    if (!response.ok) return null;
    const version = ((await response.json()) as {version?: unknown}).version;
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch { return null; }
}

async function readCache(file: string): Promise<Cache> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Cache; } catch { return {}; }
}
async function writeCache(file: string, cache: Cache) {
  try { await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, JSON.stringify(cache)); } catch { /* the cache is only an optimisation */ }
}

/**
 * Asks the npm registry for the latest version at most once a day (cached in the state directory).
 * Network failure, opt-out and a malformed answer all mean "no update known". Returns info only when latest is newer.
 */
export async function checkForUpdate(options: {
  stateDirectory: string; pkg: PackageInfo; env?: NodeJS.ProcessEnv; now?: () => number; fetchImpl?: typeof fetch; force?: boolean; mode?: Paths['mode'];
}): Promise<UpdateInfo | null> {
  const env = options.env ?? process.env;
  if (!updateCheckEnabled(options.mode ?? paths.mode, env)) return null;
  const now = options.now ?? Date.now;
  const file = path.join(options.stateDirectory, 'update-check.json');
  const cache = await readCache(file);
  let latest = cache.latest;
  const fresh = cache.checked_at && now() - Date.parse(cache.checked_at) < DAY_MS;
  if (options.force || !fresh || !latest) {
    const fetched = await fetchLatest(options.pkg.name, {registry: env.BRIDGE_UPDATE_REGISTRY, fetchImpl: options.fetchImpl});
    if (fetched) { latest = fetched; await writeCache(file, {...cache, checked_at: new Date(now()).toISOString(), latest}); }
  }
  return latest && VERSION.test(latest) && compareVersions(latest, options.pkg.version) > 0 ? {current: options.pkg.version, latest} : null;
}

/** True when the owner said "not now" for this version within the last day (so start-up does not nag on every run). */
export async function isSnoozed(stateDirectory: string, version: string, now: () => number = Date.now): Promise<boolean> {
  const cache = await readCache(path.join(stateDirectory, 'update-check.json'));
  return cache.snoozed_version === version && Boolean(cache.snoozed_until) && Date.parse(cache.snoozed_until!) > now();
}
export async function snooze(stateDirectory: string, version: string, now: () => number = Date.now): Promise<void> {
  const file = path.join(stateDirectory, 'update-check.json');
  await writeCache(file, {...(await readCache(file)), snoozed_version: version, snoozed_until: new Date(now() + DAY_MS).toISOString()});
}

// What the web UI shows: set by the background check while the server runs.
let known: UpdateInfo | null = null;
export const knownUpdate = () => known;
export const setKnownUpdate = (info: UpdateInfo | null) => { known = info; };

const npmBinary = () => process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** True only when this package lives in npm's global root, i.e. `npm install -g` is the command that replaces it. */
export async function isGlobalInstall(root = paths.packageRoot): Promise<boolean> {
  try {
    const globalRoot = execFileSync(npmBinary(), ['root', '-g'], {encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return (await realpath(globalRoot)) === path.dirname(await realpath(root)) || (await realpath(globalRoot)) === path.dirname(path.dirname(await realpath(root)));
  } catch { return false; }
}
export const installArgs = (name: string, version: string) => ['install', '-g', `${name}@${version}`];

/** Runs `npm install -g <name>@<version>` in the foreground. Only called after the owner agreed or typed the update command. */
export function runGlobalInstall(name: string, version: string): number {
  if (!VERSION.test(version)) throw new Error('Refusing to install an unexpected version string');
  return spawnSync(npmBinary(), installArgs(name, version), {stdio: 'inherit', shell: process.platform === 'win32'}).status ?? 1;
}
