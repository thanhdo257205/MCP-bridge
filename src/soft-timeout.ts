import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * "Soft deadline": instead of stopping a task the moment its time limit is reached, the bridge checks whether Antigravity still shows signs of
 * life (output on stdout/stderr, or growth of the log file it is asked to write) and extends the task while it does. The checks come after
 * 1 minute, then 5, then every 10; the task is stopped when a check finds no activity in the window since the last one, or at an absolute limit.
 * Off by default: the signals are only as good as what `agy` really writes, and with none the behavior is the old hard deadline.
 * Owner-controlled (web UI); read on every task, so a change needs no restart.
 */
export const SOFT_TIMEOUT_FILE = 'soft-timeout.json';
export const CHECK_DELAYS_SECONDS = [60, 300, 600];
export const DEFAULT_ABSOLUTE_LIMIT_SECONDS = 7200;
export const MIN_ABSOLUTE_LIMIT_SECONDS = 600;
export const MAX_ABSOLUTE_LIMIT_SECONDS = 28800;

export interface SoftTimeout { enabled: boolean; limit_seconds: number; }
export const isAbsoluteLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_ABSOLUTE_LIMIT_SECONDS && value <= MAX_ABSOLUTE_LIMIT_SECONDS;

/** Anything missing, unreadable or out of range means "off" with the default limit. */
export function readSoftTimeout(stateDirectory: string): SoftTimeout {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDirectory, SOFT_TIMEOUT_FILE), 'utf8')) as {enabled?: unknown; limit_seconds?: unknown};
    // The stored limit may be anything the owner could ever choose; a value outside the allowed range is ignored rather than trusted.
    const limit = typeof parsed.limit_seconds === 'number' && Number.isInteger(parsed.limit_seconds) && parsed.limit_seconds >= 1 && parsed.limit_seconds <= MAX_ABSOLUTE_LIMIT_SECONDS
      ? parsed.limit_seconds : DEFAULT_ABSOLUTE_LIMIT_SECONDS;
    return {enabled: parsed.enabled === true, limit_seconds: limit};
  } catch { return {enabled: false, limit_seconds: DEFAULT_ABSOLUTE_LIMIT_SECONDS}; }
}
export async function writeSoftTimeout(stateDirectory: string, value: SoftTimeout): Promise<void> {
  const file = path.join(stateDirectory, SOFT_TIMEOUT_FILE);
  if (!value.enabled && value.limit_seconds === DEFAULT_ABSOLUTE_LIMIT_SECONDS) { await rm(file, {force: true}); return; }
  if (!isAbsoluteLimit(value.limit_seconds)) throw new Error(`limit_seconds must be a whole number from ${MIN_ABSOLUTE_LIMIT_SECONDS} to ${MAX_ABSOLUTE_LIMIT_SECONDS}`);
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({enabled: value.enabled, limit_seconds: value.limit_seconds}) + '\n');
  await rename(`${file}.tmp`, file);
}

/**
 * Length of the n-th wait (0-based) that a client asks for without choosing a length: 1 minute, then 5, then the owner's maximum, each
 * never above that maximum. Waits that end early (the task finished) cost nothing, so this mainly makes "still running" reports arrive soon at first.
 */
export function rampedWaitSeconds(count: number, capSeconds: number): number {
  const steps = [60, 300, capSeconds];
  return Math.min(capSeconds, steps[Math.min(count, steps.length - 1)]);
}
