import path from 'node:path';
import { z } from 'zod';
import type { AgentFamily, DeniedAction, Elevation } from './agents/types.js';

/**
 * The owner's approval queue (docs/APPROVAL-QUEUE-PLAN.md): a task that ended with actions its agent was refused can be run again, as a new task,
 * with a little more permission for that one run, or be dismissed. No CLI the bridge drives lets a person approve in the middle of a run, so
 * this is approval afterwards. Nothing here widens a setting: the permission granted is an Elevation stored on the new task and applied to its
 * own launch only, and the only way to create one is the owner's confirmed request in the web UI (there is no MCP tool for it).
 */

/** Strict on purpose: an unknown kind or field is refused, not ignored. */
export const elevationSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('agy-level'), level: z.enum(['accept-edits', 'auto', 'full'])}).strict(),
  z.object({kind: z.literal('codex-add-dir'), dir: z.string().min(1).max(4096)}).strict(),
  z.object({kind: z.literal('opencode-allow'), permission: z.enum(['bash', 'edit'])}).strict(),
  z.object({kind: z.literal('opencode-auto')}).strict()
]);

export function parseElevation(value: unknown): Elevation {
  const parsed = elevationSchema.safeParse(value);
  if (!parsed.success) throw new Error('elevation is not one of the permissions this agent can be given');
  return parsed.data;
}

/** One permission the owner may pick for a task, with enough to explain it. `elevation` is null while it still needs a value (a directory). */
export interface ElevationOption {
  kind: Elevation['kind'];
  elevation: Elevation | null;
  /** Needs a directory typed by the owner (codex only). */
  needs_dir: boolean;
  /** The narrowest option the CLI offers for this case; the page preselects it. */
  narrowest: boolean;
  /** Takes approval away for far more than the denied actions (everything the CLI would otherwise ask about, or the whole machine). */
  wide: boolean;
}

/** OpenCode names the tool (`shell`, `write`, ...), its permission config names the permission (`bash`, `edit`). */
const OPENCODE_PERMISSION: Record<string, 'bash' | 'edit'> = {shell: 'bash', bash: 'bash', write: 'edit', edit: 'edit', patch: 'edit', multiedit: 'edit'};

export function opencodePermissionsOf(denied: DeniedAction[]): ('bash' | 'edit')[] {
  return [...new Set(denied.flatMap(item => OPENCODE_PERMISSION[item.action.toLowerCase()] ?? []))];
}

/** What the owner may pick for a task of this agent family that was refused these actions. Empty when there is no narrow way (the queue then only dismisses). */
export function elevationOptions(family: AgentFamily, denied: DeniedAction[]): ElevationOption[] {
  if (!denied.length) return [];
  if (family === 'antigravity') {
    return [
      {kind: 'agy-level', elevation: {kind: 'agy-level', level: 'accept-edits'}, needs_dir: false, narrowest: true, wide: false},
      {kind: 'agy-level', elevation: {kind: 'agy-level', level: 'auto'}, needs_dir: false, narrowest: false, wide: false},
      {kind: 'agy-level', elevation: {kind: 'agy-level', level: 'full'}, needs_dir: false, narrowest: false, wide: true}
    ];
  }
  if (family === 'codex') return [{kind: 'codex-add-dir', elevation: null, needs_dir: true, narrowest: true, wide: false}];
  const allowed = opencodePermissionsOf(denied);
  return [
    ...allowed.map((permission): ElevationOption => ({kind: 'opencode-allow', elevation: {kind: 'opencode-allow', permission}, needs_dir: false, narrowest: true, wide: false})),
    {kind: 'opencode-auto', elevation: {kind: 'opencode-auto'}, needs_dir: false, narrowest: false, wide: true}
  ];
}

/** Why an elevation may not be given to this task, or null when it may. The directory itself is checked on disk by the caller. */
export function elevationRefusal(family: AgentFamily, denied: DeniedAction[], elevation: Elevation): string | null {
  const offered = elevationOptions(family, denied);
  if (!offered.some(option => option.kind === elevation.kind)) return `This agent cannot be given "${elevation.kind}"`;
  if (elevation.kind === 'agy-level') return null;
  if (elevation.kind === 'opencode-auto') return null;
  if (elevation.kind === 'opencode-allow') return opencodePermissionsOf(denied).includes(elevation.permission) ? null : `The task was not refused "${elevation.permission}"`;
  const dir = elevation.dir;
  if (dir.includes('\0') || !path.isAbsolute(dir)) return 'The directory must be an absolute path';
  if (path.parse(path.resolve(dir)).root === path.resolve(dir)) return 'A drive or filesystem root cannot be opened to an agent';
  return null;
}

/** The agent family an elevation belongs to: one given for codex must never reach an opencode launch, and the other way round. */
export const elevationFamily = (elevation: Elevation): AgentFamily =>
  elevation.kind === 'agy-level' ? 'antigravity' : elevation.kind === 'codex-add-dir' ? 'codex' : 'opencode';

/** One line for the decision log and the page: what was granted, in the CLI's own terms. */
export function describeElevation(elevation: Elevation): string {
  switch (elevation.kind) {
    case 'agy-level': return elevation.level === 'full' ? 'antigravity --dangerously-skip-permissions' : `antigravity --mode ${elevation.level}`;
    case 'codex-add-dir': return `codex --add-dir ${elevation.dir}`;
    case 'opencode-allow': return `opencode permission ${elevation.permission}=allow`;
    case 'opencode-auto': return 'opencode --auto';
  }
}

/** What the queue needs from a task; the manager's Task satisfies it. */
export interface ApprovalSubject {
  task_id: string; status: string; denied_actions: DeniedAction[];
  approval?: {state: 'rerun' | 'dismissed'} | null;
}

/** Waiting for the owner: finished, refused something, and not yet rerun or dismissed. */
export function isPendingApproval(task: ApprovalSubject): boolean {
  return task.denied_actions.length > 0 && task.status !== 'queued' && task.status !== 'running' && !task.approval;
}
