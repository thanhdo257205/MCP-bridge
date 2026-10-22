import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * How long one `antigravity_task_wait` call may block, chosen by the bridge owner in the web UI. While a call is blocked the client's model
 * spends no tokens, so a longer wait means fewer calls. It must stay below the client's own tool timeout (Codex: `tool_timeout_sec`).
 * Read on every call, so a change needs no restart.
 */
export const WAIT_FILE = 'wait.json';
export const MIN_WAIT_SECONDS = 5;
export const MAX_SETTING_WAIT_SECONDS = 3600;
export const isWaitSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_WAIT_SECONDS && value <= MAX_SETTING_WAIT_SECONDS;

/** The owner's choice, or null when none is set (the config file value or the default then applies). Unreadable or out-of-range means null. */
export function readWait(stateDirectory: string): number | null {
  try {
    const seconds = (JSON.parse(readFileSync(path.join(stateDirectory, WAIT_FILE), 'utf8')) as {seconds?: unknown}).seconds;
    return isWaitSeconds(seconds) ? seconds : null;
  } catch { return null; }
}
export async function writeWait(stateDirectory: string, seconds: number | null): Promise<void> {
  const file = path.join(stateDirectory, WAIT_FILE);
  if (seconds === null) { await rm(file, {force: true}); return; }
  if (!isWaitSeconds(seconds)) throw new Error(`wait must be a whole number of seconds from ${MIN_WAIT_SECONDS} to ${MAX_SETTING_WAIT_SECONDS}`);
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({seconds}) + '\n');
  await rename(`${file}.tmp`, file);
}

/** The tool timeout the client should be given for a wait of this length: the wait plus a margin, never below the usual 60 seconds. */
export const clientToolTimeoutSeconds = (waitSeconds: number): number => Math.max(60, waitSeconds + 60);
