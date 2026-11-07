import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { redact } from '../security/redact.js';

/**
 * Worktree setup, after Orca's per-repository `orca.yaml` setup script, with one difference that matters: the commands come from the
 * bridge OWNER's config, never from the repository. A worktree is a fresh checkout without `node_modules` or a build, so an agent that is
 * told to run the tests cannot; the owner can name the commands that make one usable. They run as argv lists without a shell, in the new
 * worktree, with the same filtered environment as the agent, before the agent starts (see setup-runner.ts).
 */
export const worktreeSetupSchema = z.object({
  /** An allowed workspace, exactly as it appears in allowed_workspaces (matched by its real path). */
  workspace: z.string().min(1).max(4096),
  /** Each command is an argv list run without a shell, e.g. ["npm", "ci"]. They run in order; the first failure stops the task. */
  commands: z.array(z.array(z.string().min(1).max(4096)).min(1).max(64)).min(1).max(10),
  /** Time for all commands together; part of the task's own timeout too, since the agent only starts after them. */
  timeout_seconds: z.number().int().min(1).max(1800).default(300)
}).strict();
export type WorktreeSetup = z.infer<typeof worktreeSetupSchema>;

export interface SetupSpec { commands: string[][]; timeout_ms: number; report: string; }
export interface SetupCommandResult { command: string[]; exit_code: number | null; signal: string | null; duration_ms: number; output_tail: string; }
export interface SetupReport { ok: boolean; duration_ms: number; commands: SetupCommandResult[]; error?: string; }

export const setupRunnerPath = (): string => fileURLToPath(new URL('./setup-runner.js', import.meta.url));

/** The setup declared for this (already validated, real) workspace, or null. Only an exact match counts, never a parent or child directory. */
export async function setupFor(entries: WorktreeSetup[] | undefined, workspace: string): Promise<WorktreeSetup | null> {
  for (const entry of entries ?? []) {
    const real = await realpath(entry.workspace).catch(() => null);
    if (real !== null && real === workspace) return entry;
  }
  return null;
}

/** Writes the runner's spec; returns the command line that runs the setup and then the agent in its place. */
export async function wrapWithSetup(setup: WorktreeSetup, stateDirectory: string, taskId: string, executable: string, args: string[]): Promise<{executable: string; args: string[]; report: string}> {
  const directory = path.join(stateDirectory, 'setup');
  await mkdir(directory, {recursive: true});
  const report = path.join(directory, `${taskId}.report.json`);
  const specFile = path.join(directory, `${taskId}.spec.json`);
  const spec: SetupSpec = {commands: setup.commands, timeout_ms: setup.timeout_seconds * 1000, report};
  await writeFile(specFile, JSON.stringify(spec), {mode: 0o600});
  return {executable: process.execPath, args: [setupRunnerPath(), specFile, '--', executable, ...args], report};
}

/** The runner's report, with output filtered like task logs. Null when setup never wrote one (it was killed first). */
export async function readSetupReport(file: string): Promise<SetupReport | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as SetupReport;
    return {
      ok: value.ok === true, duration_ms: Number(value.duration_ms) || 0,
      commands: (value.commands ?? []).slice(0, 10).map(item => ({
        command: item.command.map(part => redact(String(part)).slice(0, 300)), exit_code: item.exit_code ?? null, signal: item.signal ?? null,
        duration_ms: Number(item.duration_ms) || 0, output_tail: redact(String(item.output_tail ?? '')).slice(-4000)
      })),
      ...(value.error ? {error: redact(String(value.error)).slice(0, 500)} : {})
    };
  } catch { return null; }
}
