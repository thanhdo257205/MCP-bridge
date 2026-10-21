import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reasoning effort passed to Antigravity as `--effort`. Lower is faster and thinks less. `default` passes no flag, so Antigravity's own
 * setting applies. Chosen by the bridge owner in the web UI; read on every task, so a change needs no restart.
 */
export const EFFORT_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export const EFFORT_FILE = 'effort.json';
export const isEffortLevel = (value: unknown): value is EffortLevel => typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

export const effortFlags = (level: EffortLevel): string[] => level === 'default' ? [] : ['--effort', level];

/** Anything missing, unreadable or unknown means `default` (no flag). */
export function readEffort(stateDirectory: string): EffortLevel {
  try {
    const level = (JSON.parse(readFileSync(path.join(stateDirectory, EFFORT_FILE), 'utf8')) as {effort?: unknown}).effort;
    return isEffortLevel(level) ? level : 'default';
  } catch { return 'default'; }
}
export async function writeEffort(stateDirectory: string, level: EffortLevel): Promise<void> {
  const file = path.join(stateDirectory, EFFORT_FILE);
  if (level === 'default') { await rm(file, {force: true}); return; }
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({effort: level}) + '\n');
  await rename(`${file}.tmp`, file);
}
