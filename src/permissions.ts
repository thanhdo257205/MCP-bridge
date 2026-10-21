import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * How much Antigravity may do on its own while a delegated task runs, lowest to highest.
 * Chosen by the bridge owner in the web UI (or BRIDGE_AGY_PERMISSIONS); never by an MCP client.
 *  default      no flag: Antigravity's own settings decide (headless runs soft-deny anything that needs approval)
 *  plan         --mode plan: planning only
 *  accept-edits --mode accept-edits: file edits are approved automatically
 *  auto         --mode auto: Antigravity's automatic mode
 *  full         --dangerously-skip-permissions: every tool request is approved, including commands and paths outside the workspace
 */
export const PERMISSION_LEVELS = ['default', 'plan', 'accept-edits', 'auto', 'full'] as const;
export type PermissionLevel = typeof PERMISSION_LEVELS[number];
export const PERMISSION_FILE = 'permissions.json';
export const isPermissionLevel = (value: unknown): value is PermissionLevel => typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
/** Levels that need an explicit acknowledgement before they can be set. */
export const needsAcknowledgement = (level: PermissionLevel) => level === 'auto' || level === 'full';

export function permissionFlags(level: PermissionLevel): string[] {
  switch (level) {
    case 'plan': return ['--mode', 'plan'];
    case 'accept-edits': return ['--mode', 'accept-edits'];
    case 'auto': return ['--mode', 'auto'];
    case 'full': return ['--dangerously-skip-permissions'];
    default: return [];
  }
}
/** The less privileged of two levels (used so lowering the setting also applies to tasks that are already queued). */
export const lowerLevel = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => PERMISSION_LEVELS.indexOf(a) <= PERMISSION_LEVELS.indexOf(b) ? a : b;

export interface PermissionState { level: PermissionLevel; source: 'default' | 'file' | 'env'; controllable: boolean; reason: string | null; }

/**
 * The environment variable wins and locks the setting. Anything unreadable or unknown means "default" (least privilege), never a higher level.
 * Read synchronously and on every task, so a change needs no restart.
 */
export function permissionState(stateDirectory: string, env: NodeJS.ProcessEnv = process.env): PermissionState {
  const forced = env.BRIDGE_AGY_PERMISSIONS?.trim().toLowerCase();
  if (forced !== undefined && forced !== '') {
    return isPermissionLevel(forced)
      ? {level: forced, source: 'env', controllable: false, reason: 'BRIDGE_AGY_PERMISSIONS'}
      : {level: 'default', source: 'env', controllable: false, reason: `BRIDGE_AGY_PERMISSIONS has an invalid value (use ${PERMISSION_LEVELS.join(', ')}); using default`};
  }
  try {
    const level = (JSON.parse(readFileSync(path.join(stateDirectory, PERMISSION_FILE), 'utf8')) as {level?: unknown}).level;
    if (isPermissionLevel(level)) return {level, source: 'file', controllable: true, reason: null};
  } catch { /* no file, or unreadable: default */ }
  return {level: 'default', source: 'default', controllable: true, reason: null};
}
export async function writePermission(stateDirectory: string, level: PermissionLevel): Promise<void> {
  const file = path.join(stateDirectory, PERMISSION_FILE);
  if (level === 'default') { await rm(file, {force: true}); return; }
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({level, set_at: new Date().toISOString()}) + '\n', {mode: 0o600});
  await rename(`${file}.tmp`, file);
}
