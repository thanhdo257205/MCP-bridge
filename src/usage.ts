import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Usage of Antigravity as the bridge sees it. agy's result carries `usage`, `duration_seconds` and `num_turns`; what is inside `usage` is not
 * assumed: every numeric value in it is kept under its own name (nested names joined with a dot) and summed. Nothing here is a quota: the
 * bridge has no source for "remaining" and does not invent one.
 */
export const USAGE_FILE = 'usage.jsonl';
const MAX_FILE_BYTES = 1_000_000;
const KEEP_RECORDS = 3000;

export interface TaskStats { usage: Record<string, number> | null; agy_duration_seconds: number | null; num_turns: number | null; steps: number | null; }
export interface UsageRecord {
  at: string; status: string; model: string | null; effort: string | null; permission: string | null;
  duration_ms: number; agy_duration_seconds: number | null; num_turns: number | null; steps: number | null; usage: Record<string, number> | null;
}

const SAFE_KEY = /^[A-Za-z0-9_.-]{1,60}$/;
/** Numeric leaves of an object, at most three levels deep and 40 of them, keyed by their dotted path. */
export function flattenNumbers(value: unknown, prefix = '', depth = 0, out: Record<string, number> = {}): Record<string, number> {
  if (typeof value === 'number') { if (Number.isFinite(value) && prefix && SAFE_KEY.test(prefix)) out[prefix] = value; return out; }
  if (depth >= 3 || typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 40) break;
    flattenNumbers(inner, prefix ? `${prefix}.${key}` : key, depth + 1, out);
  }
  return out;
}
const finiteOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** What the result of one task says about its own cost. All parts are optional: agy may leave any of them out. */
export function extractStats(result: Record<string, unknown>, steps: number | null): TaskStats {
  const usage = flattenNumbers(result.usage);
  return {usage: Object.keys(usage).length ? usage : null, agy_duration_seconds: finiteOrNull(result.duration_seconds), num_turns: finiteOrNull(result.num_turns), steps};
}

/** One line per finished task, kept across restarts (the task history itself keeps only the latest tasks). Trimmed when the file grows large. */
export async function appendUsage(stateDirectory: string, record: UsageRecord): Promise<void> {
  const file = path.join(stateDirectory, USAGE_FILE);
  try {
    await appendFile(file, JSON.stringify(record) + '\n', {mode: 0o600});
    if ((await stat(file)).size > MAX_FILE_BYTES) {
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      await writeFile(file, lines.slice(-KEEP_RECORDS).join('\n') + '\n', {mode: 0o600});
    }
  } catch { /* statistics are a convenience, never a reason to fail a task */ }
}
export async function readUsage(stateDirectory: string): Promise<UsageRecord[]> {
  let text: string;
  try { text = await readFile(path.join(stateDirectory, USAGE_FILE), 'utf8'); } catch { return []; }
  const records: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as UsageRecord;
      if (typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && typeof value.status === 'string' && typeof value.duration_ms === 'number') records.push(value);
    } catch { /* skip a damaged line */ }
  }
  return records;
}

const add = (target: Record<string, number>, source: Record<string, number> | null | undefined) => {
  for (const [key, value] of Object.entries(source ?? {})) target[key] = (target[key] ?? 0) + value;
};
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
interface Group { tasks: number; completed: number; duration_ms: number; turns: number; usage: Record<string, number>; }
const newGroup = (): Group => ({tasks: 0, completed: 0, duration_ms: 0, turns: 0, usage: {}});
function addTo(group: Group, record: UsageRecord) {
  group.tasks += 1; if (record.status === 'completed') group.completed += 1;
  group.duration_ms += record.duration_ms; group.turns += record.num_turns ?? 0; add(group.usage, record.usage);
}

/**
 * Totals, a split by model and by effort, and the last `days` days. Days are the viewer's local days: `tzOffsetMinutes` is what
 * `new Date().getTimezoneOffset()` returns in the browser (minutes behind UTC, so UTC+7 is -420).
 */
export function summarizeUsage(records: UsageRecord[], options: {now?: number; tzOffsetMinutes?: number; days?: number} = {}) {
  const now = options.now ?? Date.now();
  const offsetMs = -(options.tzOffsetMinutes ?? 0) * 60000;
  const days = options.days ?? 14;
  const dayOf = (ms: number) => new Date(ms + offsetMs).toISOString().slice(0, 10);
  const totals = newGroup();
  const byStatus: Record<string, number> = {};
  const byModel = new Map<string, Group>();
  const byEffort = new Map<string, Group>();
  const byDay = new Map<string, Group>();
  for (let i = days - 1; i >= 0; i--) byDay.set(dayOf(now - i * 86400000), newGroup());
  for (const record of records) {
    addTo(totals, record); byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    const model = record.model ?? 'default'; byModel.set(model, byModel.get(model) ?? newGroup()); addTo(byModel.get(model)!, record);
    const effort = record.effort ?? 'default'; byEffort.set(effort, byEffort.get(effort) ?? newGroup()); addTo(byEffort.get(effort)!, record);
    const day = byDay.get(dayOf(Date.parse(record.at))); if (day) addTo(day, record);
  }
  const list = (map: Map<string, Group>) => [...map].map(([key, group]) => ({key, ...group})).sort((a, b) => b.tasks - a.tasks).slice(0, 12);
  return {
    since: records.length ? records[0].at : null,
    totals: {...totals, by_status: byStatus, steps: sum(records.map(r => r.steps)), agy_duration_seconds: sum(records.map(r => r.agy_duration_seconds)),
      with_usage: records.filter(r => r.usage).length},
    by_model: list(byModel), by_effort: list(byEffort),
    by_day: [...byDay].map(([day, group]) => ({day, ...group})),
    recent: records.slice(-15).reverse().map(r => ({at: r.at, status: r.status, model: r.model, effort: r.effort, duration_ms: r.duration_ms, agy_duration_seconds: r.agy_duration_seconds, num_turns: r.num_turns, usage: r.usage}))
  };
}

/** Tokens a task cost according to agy: its own total when it reports one, else input plus output; null when it reported neither. */
export function totalTokens(usage: Record<string, number> | null | undefined): number | null {
  if (!usage) return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const parts = [usage.input_tokens, usage.output_tokens].filter((value): value is number => typeof value === 'number');
  return parts.length ? parts.reduce((total, value) => total + value, 0) : null;
}
