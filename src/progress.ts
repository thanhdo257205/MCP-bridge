import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './security/redact.js';

/**
 * Step progress. With this on, tasks run `agy --print <prompt> --output-format stream-json`: besides the final `result`, agy emits
 * `init` and `step_update` events while it works (seen with `agy-mcp-bridge probe-stream`). The bridge keeps the steps for the web UI and
 * treats them as proof of life. Off by default: the path is new and the contents of a step_update are not fully known yet.
 * Owner-controlled (web UI); read on every task, so a change needs no restart.
 */
export const PROGRESS_FILE = 'progress.json';
export const readProgress = (stateDirectory: string): {enabled: boolean} => {
  try { return {enabled: (JSON.parse(readFileSync(path.join(stateDirectory, PROGRESS_FILE), 'utf8')) as {enabled?: unknown}).enabled === true}; }
  catch { return {enabled: false}; }
};
export async function writeProgress(stateDirectory: string, enabled: boolean): Promise<void> {
  const file = path.join(stateDirectory, PROGRESS_FILE);
  if (!enabled) { await rm(file, {force: true}); return; }
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({enabled: true}) + '\n');
  await rename(`${file}.tmp`, file);
}

export interface Step { n: number; at: number; summary: string; raw: string; }
export const MAX_RECENT_STEPS = 100;
const PREFERRED = ['title', 'name', 'tool', 'tool_name', 'type', 'kind', 'status', 'state', 'action', 'description', 'summary', 'message', 'text', 'content', 'path', 'file', 'command'];

const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * One line describing a step_update. Its fields are decided by agy and only the top-level keys of the event are known, so this picks the
 * descriptive-looking fields (title, type, status, tool, message, ...) it finds, one level down if needed, and falls back to the field names.
 * Everything is redacted and shortened. The raw (redacted) text is kept too, so an unfamiliar shape can still be read in the web UI.
 */
export function summarizeStep(value: unknown): string {
  const direct = scalar(value);
  if (direct) return redact(clip(direct, 200));
  if (typeof value !== 'object' || value === null) return '(empty step)';
  const object = Array.isArray(value) ? {items: value} : value as Record<string, unknown>;
  const parts: string[] = [];
  const take = (source: Record<string, unknown>) => {
    for (const key of PREFERRED) {
      if (parts.length >= 3) return;
      const text = scalar(source[key]);
      if (text && !parts.includes(clip(text, 80))) parts.push(clip(text, 80));
    }
  };
  take(object);
  if (!parts.length) for (const nested of Object.values(object)) if (nested && typeof nested === 'object' && !Array.isArray(nested)) { take(nested as Record<string, unknown>); if (parts.length) break; }
  if (parts.length) return redact(clip(parts.join(' · '), 200));
  const keys = Object.keys(object).slice(0, 6);
  return keys.length ? `{${keys.join(', ')}}` : '(empty step)';
}

export function rawStep(value: unknown): string {
  try { return redact(clip(JSON.stringify(value) ?? '', 600)); } catch { return ''; }
}
