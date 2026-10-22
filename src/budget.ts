import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readUsage, totalTokens, USAGE_FILE, type UsageRecord } from './usage.js';

/**
 * Token budget: two limits the owner sets in the web UI, a warning light and nothing more. agy exposes no quota to read, and the token count of
 * a task is only known when its result arrives, so the bridge cannot stop a task midway; it can show which finished tasks went over the per-task
 * limit and whether today's total passed the daily limit. Read on every overview, so a change needs no restart.
 */
export const BUDGET_FILE = 'budget.json';
export const MIN_BUDGET_TOKENS = 1000;
export const MAX_BUDGET_TOKENS = 1_000_000_000;

export interface Budget { task_tokens: number | null; day_tokens: number | null; }
export const isBudgetTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_BUDGET_TOKENS && value <= MAX_BUDGET_TOKENS;
const valid = (value: unknown) => isBudgetTokens(value) ? value : null;

/** Anything missing, unreadable or out of range means "no limit". */
export function readBudget(stateDirectory: string): Budget {
  try {
    const parsed = JSON.parse(readFileSync(path.join(stateDirectory, BUDGET_FILE), 'utf8')) as {task_tokens?: unknown; day_tokens?: unknown};
    return {task_tokens: valid(parsed.task_tokens), day_tokens: valid(parsed.day_tokens)};
  } catch { return {task_tokens: null, day_tokens: null}; }
}
export async function writeBudget(stateDirectory: string, value: Budget): Promise<void> {
  const file = path.join(stateDirectory, BUDGET_FILE);
  if (value.task_tokens === null && value.day_tokens === null) { await rm(file, {force: true}); return; }
  for (const limit of [value.task_tokens, value.day_tokens]) if (limit !== null && !isBudgetTokens(limit)) throw new Error(`limits must be whole numbers from ${MIN_BUDGET_TOKENS} to ${MAX_BUDGET_TOKENS}, or null for no limit`);
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify(value) + '\n');
  await rename(`${file}.tmp`, file);
}

/** Tokens used on the viewer's current local day (`tzOffsetMinutes` as `getTimezoneOffset()` returns it). */
export function tokensToday(records: UsageRecord[], now: number, tzOffsetMinutes: number): number {
  const offsetMs = -tzOffsetMinutes * 60000;
  const dayOf = (ms: number) => new Date(ms + offsetMs).toISOString().slice(0, 10);
  const today = dayOf(now);
  return records.reduce((total, record) => dayOf(Date.parse(record.at)) === today ? total + (totalTokens(record.usage) ?? 0) : total, 0);
}

// The overview is polled every few seconds; the ledger is re-read only when its size or time changed.
let cache: {key: string; records: UsageRecord[]} | null = null;
async function cachedRecords(stateDirectory: string): Promise<UsageRecord[]> {
  const file = path.join(stateDirectory, USAGE_FILE);
  let key: string;
  try { const info = await stat(file); key = `${file}:${info.size}:${info.mtimeMs}`; } catch { return []; }
  if (cache?.key !== key) cache = {key, records: await readUsage(stateDirectory)};
  return cache.records;
}

export async function budgetState(stateDirectory: string, tzOffsetMinutes: number, now = Date.now()) {
  const budget = readBudget(stateDirectory);
  const today = tokensToday(await cachedRecords(stateDirectory), now, tzOffsetMinutes);
  return {...budget, today_tokens: today, over_day: budget.day_tokens !== null && today >= budget.day_tokens};
}
