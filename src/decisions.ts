import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The owner's decisions about a finished task (apply its changes, discard its worktree), one line each. The task history keeps only the
 * latest tasks, so this is the record of who changed the workspace and when. Trimmed when the file grows large.
 */
export const DECISIONS_FILE = 'decisions.jsonl';
const MAX_FILE_BYTES = 512 * 1024;
const KEEP_RECORDS = 500;

export type DecisionAction = 'apply' | 'discard' | 'approve' | 'rerun' | 'dismiss';
const ACTIONS: readonly string[] = ['apply', 'discard', 'approve', 'rerun', 'dismiss'];
export interface Decision {
  at: string;
  task_id: string;
  action: DecisionAction;
  ok: boolean;
  /** Files applied, or the reason the action was refused or failed. Never file contents. */
  detail: string;
}

export async function appendDecision(stateDirectory: string, decision: Decision): Promise<void> {
  const file = path.join(stateDirectory, DECISIONS_FILE);
  try {
    await mkdir(stateDirectory, {recursive: true});
    await appendFile(file, JSON.stringify(decision) + '\n', {mode: 0o600});
    if ((await stat(file)).size > MAX_FILE_BYTES) {
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      await writeFile(file, lines.slice(-KEEP_RECORDS).join('\n') + '\n', {mode: 0o600});
    }
  } catch { /* the log is a convenience, never a reason to fail the action it describes */ }
}

/** Newest first. A damaged line is skipped. */
export async function readDecisions(stateDirectory: string, limit = 50): Promise<Decision[]> {
  let text: string;
  try { text = await readFile(path.join(stateDirectory, DECISIONS_FILE), 'utf8'); } catch { return []; }
  const records: Decision[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Decision;
      if (typeof value.at === 'string' && typeof value.task_id === 'string' && ACTIONS.includes(value.action) && typeof value.ok === 'boolean') {
        records.push({at: value.at, task_id: value.task_id, action: value.action, ok: value.ok, detail: String(value.detail ?? '').slice(0, 500)});
      }
    } catch { /* skip a damaged line */ }
  }
  return records.slice(-limit).reverse();
}
