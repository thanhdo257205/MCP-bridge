import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { isRelativeFilePath } from '../isolation/diff.js';
import { inside } from '../security/workspace.js';
import { redact } from '../security/redact.js';

/**
 * Review feedback, after Orca's "leave notes on exact changed lines and send them back to the agent": a reviewer who read a finished task's
 * diff hands the bridge a few notes anchored to file and line, and the bridge turns them into ONE follow-up task for the same agent. The
 * notes quote the lines as they are on disk now, so the agent is pointed at code rather than at a description of it, and a worktree
 * follow-up starts from the earlier task's changes instead of from a clean checkout. Nothing here merges, applies or commits anything.
 */
export const MAX_NOTES = 30;
const CONTEXT_LINES = 2;
const MAX_LINE_CHARS = 240;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ORIGINAL_TASK_CHARS = 5000;

export const feedbackNoteSchema = z.object({
  path: z.string().trim().min(1).max(512).describe('File the note is about, relative to the task workspace, as the diff lists it'),
  line: z.number().int().min(1).max(10_000_000).optional().describe('1-based line in the file as it is now (the right-hand side of the diff); omit for a note about the whole file'),
  end_line: z.number().int().min(1).max(10_000_000).optional().describe('Last line of a range starting at line'),
  note: z.string().trim().min(1).max(2000).describe('What is wrong or what to change, in the reviewer\'s words')
}).strict().refine(value => value.end_line === undefined || (value.line !== undefined && value.end_line >= value.line && value.end_line - value.line <= 200),
  'end_line needs line, must not come before it, and a range is at most 200 lines');

export const feedbackSchema = z.object({
  task_id: z.uuid(),
  notes: z.array(feedbackNoteSchema).min(1).max(MAX_NOTES),
  instruction: z.string().trim().min(1).max(2000).optional().describe('One overall instruction for the follow-up, beside the notes'),
  timeout_seconds: z.number().int().min(1).max(3600).optional()
}).strict();
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type FeedbackNote = z.infer<typeof feedbackNoteSchema>;

export interface QuotedNote extends FeedbackNote {
  /** The anchored lines with their numbers, as they are in the task's files right now; null for a whole-file note or a file that is gone. */
  excerpt: string | null;
  missing?: boolean;
}

export function assertNotePath(note: FeedbackNote): void {
  if (!isRelativeFilePath(note.path)) throw new Error(`Note path "${note.path}" must be a relative path inside the task workspace`);
}

/** Reads the lines a note points at, from inside `root` only (a link that leads out of it is not followed). */
export async function quoteNote(root: string, note: FeedbackNote): Promise<QuotedNote> {
  assertNotePath(note);
  const base = await realpath(root);
  const real = await realpath(path.join(base, note.path)).catch(() => null);
  if (real === null) return {...note, excerpt: null, missing: true};
  if (!inside(base, real)) throw new Error(`Note path "${note.path}" leaves the task workspace through a link, so it is not read`);
  if (note.line === undefined) return {...note, excerpt: null};
  let text: string;
  try {
    const buffer = await readFile(real);
    if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) return {...note, excerpt: null};
    text = buffer.toString('utf8');
  } catch { return {...note, excerpt: null, missing: true}; }
  const lines = text.split(/\r?\n/);
  const last = note.end_line ?? note.line;
  if (note.line > lines.length) throw new Error(`Note on ${note.path}:${note.line} points past the end of the file (${lines.length} lines)`);
  const from = Math.max(1, note.line - CONTEXT_LINES);
  const to = Math.min(lines.length, last + CONTEXT_LINES);
  const width = String(to).length;
  const excerpt = lines.slice(from - 1, to).map((value, index) => {
    const number = from + index;
    const marker = number >= note.line! && number <= last ? '>' : ' ';
    const shown = value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS)}…` : value;
    return `${marker} ${String(number).padStart(width)} | ${shown}`;
  }).join('\n');
  return {...note, excerpt: redact(excerpt)};
}

/** The follow-up's task text: what was asked, then every note with the lines it is about. Fits the delegate limit by trimming the original task. */
export function feedbackTask(sourceId: string, originalTask: string, notes: QuotedNote[], instruction?: string): string {
  const original = originalTask.length > MAX_ORIGINAL_TASK_CHARS ? `${originalTask.slice(0, MAX_ORIGINAL_TASK_CHARS)}\n[…original task trimmed]` : originalTask;
  const items = notes.map((note, index) => {
    const where = note.line === undefined ? note.path : `${note.path}:${note.line}${note.end_line && note.end_line !== note.line ? `-${note.end_line}` : ''}`;
    const quoted = note.missing ? '   (this file does not exist in your workspace right now)' : note.excerpt ? note.excerpt.split('\n').map(line => `   ${line}`).join('\n') : '';
    return [`${index + 1}. ${where}: ${note.note}`, quoted].filter(Boolean).join('\n');
  });
  return [
    `Review feedback on your earlier task ${sourceId}. A reviewer read your diff and left the notes below on specific lines.`,
    'Your earlier changes are already in this workspace. Address every note, keep the rest of your earlier work as it is, and change nothing the notes do not ask for.',
    'Lines marked ">" are the ones a note is about, quoted as they are now.',
    ...(instruction ? [`Reviewer instruction: ${instruction}`] : []),
    '',
    'Notes:',
    ...items,
    '',
    'The original task, for reference:',
    original
  ].join('\n').slice(0, 15_900);
}
