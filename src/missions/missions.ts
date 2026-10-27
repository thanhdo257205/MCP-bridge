import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { Config } from '../config.js';
import { delegateSchema, type DelegateInput, type DelegateRequest } from '../security/input.js';
import { validateWorkspace } from '../security/workspace.js';
import { redact } from '../security/redact.js';
import type { Isolation } from '../agents/types.js';
import type { Status, Task, TaskSummary } from '../tasks/manager.js';

/**
 * A mission is a plan the bridge records and enforces but never runs by itself: an MCP client (the orchestrator)
 * dispatches one step at a time and waits on the returned task with the existing task tools. Keeping the plan here
 * rather than only in the client's context is what makes it survive a reconnect or a restart, and gating dispatch on
 * the recorded dependencies is what stops a worker being sent at a step whose inputs do not exist yet.
 */
export const MAX_STEPS_PER_MISSION = 12;
/** Bound the record itself: an MCP request body is capped at 131072 bytes, and the whole plan is re-read by every status call. */
export const MAX_MISSION_CHARACTERS = 100_000;
/** Oldest missions with no task still in flight are dropped first, exactly like finished tasks. */
export const MAX_RETAINED_MISSIONS = 20;

const stepIdValue = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'step_id must be a lowercase slug: a-z, 0-9, dot, dash or underscore, at most 64 characters, starting with a letter or digit');
export const stepIdSchema = stepIdValue;

export const missionStepSchema = z.object({
  step_id: stepIdValue,
  title: z.string().trim().min(1).max(200),
  depends_on: z.array(stepIdValue).max(MAX_STEPS_PER_MISSION).default([]),
  /** Everything the step will be delegated with, validated by the same schema a direct call has to pass. */
  delegate: delegateSchema
}).strict();
export type MissionStepInput = z.infer<typeof missionStepSchema>;

const stepsSchema = z.array(missionStepSchema).min(1).max(MAX_STEPS_PER_MISSION);

export const missionCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4000),
  workspace: z.string().min(1).max(4096),
  steps: stepsSchema
}).strict();
export type MissionCreateInput = z.infer<typeof missionCreateSchema>;

/** The plan is append-only: a new attempt is a new step, never an edit of a step that already ran. */
export const missionExtendSchema = z.object({mission_id: z.uuid(), steps: stepsSchema}).strict();
export const missionIdSchema = z.object({mission_id: z.uuid()}).strict();
export const missionDispatchSchema = z.object({mission_id: z.uuid(), step_id: stepIdValue}).strict();
export const missionCancelSchema = z.object({mission_id: z.uuid(), cancel_running_tasks: z.boolean().optional()}).strict();

export type MissionStatus = 'open' | 'canceled';
/** `lost` is a bound task whose record is gone (retention dropped it), not a status an agent reported. */
export type StepState = 'ready' | 'pending' | 'lost' | Status;

export interface MissionStep {
  step_id: string; title: string; depends_on: string[];
  /** Task this step was dispatched as; set once and never replaced. */
  task_id: string | null;
  delegate: DelegateInput;
}
export interface Mission {
  mission_id: string; title: string; goal: string; workspace: string;
  status: MissionStatus; client: string | null;
  created_at: string; updated_at: string; canceled_at: string | null;
  steps: MissionStep[];
}

export interface StepView {
  step_id: string; title: string; state: StepState; depends_on: string[];
  /** For a pending step: which dependencies are not `completed` yet and where each of them stands. */
  blocked_by: {step_id: string; state: StepState}[];
  task_id: string | null;
  /** null means "the bridge default agent", which is what the plan asked for. */
  agent: string | null;
  isolation: Isolation;
  scope: {checked: boolean; changed: number; out_of_scope: number} | null;
  /** Only in the plan view: `mission_status` leaves the task text out because a client reads the view repeatedly. */
  delegate?: DelegateInput;
}

export interface MissionView {
  mission_id: string; title: string; status: MissionStatus; workspace: string;
  created_at: string; updated_at: string;
  progress: {total: number; completed: number; active: number; ready: number; pending: number; unmet: number};
  /** Step ids the orchestrator may dispatch right now. */
  ready: string[];
  steps: StepView[];
  /** Only in the plan view. */
  goal?: string; client?: string | null;
}
/** The plan view: a MissionView whose steps and mission carry the recorded text. */
export type MissionPlan = MissionView & {goal: string; client: string | null; steps: Required<Pick<StepView, 'delegate'>>[]};

const MISSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Disk records are validated on the way in: a foreign or half-written file is skipped, never trusted. */
const recordSchema = z.object({
  mission: z.object({
    mission_id: z.uuid(), title: z.string(), goal: z.string(), workspace: z.string(),
    status: z.enum(['open', 'canceled']), client: z.string().nullable(),
    created_at: z.string(), updated_at: z.string(), canceled_at: z.string().nullable(),
    steps: z.array(z.object({
      step_id: stepIdValue, title: z.string(), depends_on: z.array(z.string()),
      task_id: z.string().nullable(), delegate: delegateSchema
    }).strict())
  }).strict()
}).strict();

/** Both plan shapes carry the fields the rules need, so one set of checks covers create and extend. */
interface PlanEntry { step_id: string; depends_on: string[]; delegate: {workspace: string; timeout_seconds?: number} }

/**
 * Structural rules of a plan, checked before anything is written. They cannot be expressed as per-field zod checks
 * because they span steps, and a mission failing them could never be dispatched correctly.
 */
export function assertPlan(additions: PlanEntry[], existing: PlanEntry[], workspace: string, maxTimeoutSeconds: number): void {
  const ids = new Set(existing.map(step => step.step_id));
  for (const step of additions) {
    if (ids.has(step.step_id)) throw new Error(`step_id "${step.step_id}" is already in the plan; the plan is append-only, so a retry needs a new step_id`);
    ids.add(step.step_id);
  }
  const all = [...existing, ...additions];
  const known = new Set(all.map(step => step.step_id));
  for (const step of additions) {
    if (step.delegate.workspace !== workspace) throw new Error(`step "${step.step_id}" asks for workspace ${JSON.stringify(step.delegate.workspace)}, but a mission runs entirely in ${JSON.stringify(workspace)}`);
    if (new Set(step.depends_on).size !== step.depends_on.length) throw new Error(`step "${step.step_id}" lists the same dependency twice`);
    if (step.depends_on.includes(step.step_id)) throw new Error(`step "${step.step_id}" depends on itself`);
    for (const dependency of step.depends_on) if (!known.has(dependency)) throw new Error(`step "${step.step_id}" depends on "${dependency}", which is not in the plan`);
    if (step.delegate.timeout_seconds !== undefined && step.delegate.timeout_seconds > maxTimeoutSeconds) throw new Error(`step "${step.step_id}" asks for ${step.delegate.timeout_seconds}s but the bridge limit is ${maxTimeoutSeconds}s`);
  }
  const cycle = findCycle(all);
  if (cycle) throw new Error(`dependency cycle: ${cycle.join(' -> ')}`);
  const size = JSON.stringify(all).length;
  if (size > MAX_MISSION_CHARACTERS) throw new Error(`the plan would be ${size} characters, over the ${MAX_MISSION_CHARACTERS} limit; split the mission or shorten the steps`);
}

/** Iterative DFS over the dependency graph; returns the cycle it found, or null. */
function findCycle(steps: PlanEntry[]): string[] | null {
  const edges = new Map(steps.map(step => [step.step_id, step.depends_on]));
  const done = new Set<string>();
  const onStack = new Set<string>();
  const stack: {id: string; index: number}[] = [];
  for (const root of edges.keys()) {
    if (done.has(root)) continue;
    stack.push({id: root, index: 0});
    onStack.add(root);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const children = edges.get(frame.id) ?? [];
      if (frame.index >= children.length) {
        stack.pop(); onStack.delete(frame.id); done.add(frame.id);
        continue;
      }
      const child = children[frame.index++];
      if (done.has(child) || !edges.has(child)) continue;
      if (onStack.has(child)) return [...stack.map(entry => entry.id), child];
      stack.push({id: child, index: 0});
      onStack.add(child);
    }
  }
  return null;
}

const redactedDelegate = (delegate: DelegateInput): DelegateInput => ({
  ...delegate,
  task: redact(delegate.task),
  acceptance_criteria: delegate.acceptance_criteria.map(redact),
  ...(delegate.context === undefined ? {} : {context: redact(delegate.context)})
});

const toSteps = (inputs: MissionStepInput[]): MissionStep[] =>
  inputs.map(step => ({step_id: step.step_id, title: redact(step.title), depends_on: [...step.depends_on], task_id: null, delegate: redactedDelegate(step.delegate)}));

/**
 * The part of the task manager a plan touches: start a step, read its state, stop it. Kept narrow so the dispatch
 * gates are testable against a runner that answers on the test's own schedule, without a CLI in the loop.
 */
export interface TaskRunner {
  delegate(raw: DelegateRequest, meta: {client?: string | null}): Promise<Task>;
  summary(id: string): TaskSummary;
  cancel(id: string): Promise<Task>;
  readonly stateDirectory: string;
}

export class MissionManager {
  private missions = new Map<string, Mission>();
  /** Steps whose dispatch call is in flight. Delegation is asynchronous, so without this two concurrent calls could both pass the readiness check. */
  private inFlight = new Set<string>();

  /** A plan only needs the workspace allowlist and the timeout ceiling; the task manager owns everything else. */
  constructor(private tasks: TaskRunner, private config: Pick<Config, 'allowed_workspaces' | 'max_timeout_seconds'>) {}

  get stateDirectory(): string { return this.tasks.stateDirectory; }
  private get missionsDirectory(): string { return path.join(this.tasks.stateDirectory, 'missions'); }

  async create(raw: MissionCreateInput, meta: {client?: string | null} = {}): Promise<Mission> {
    const input = missionCreateSchema.parse(raw);
    assertPlan(input.steps, [], input.workspace, this.config.max_timeout_seconds);
    // Fail at the plan rather than at the first dispatch: a workspace outside the allowlist can never run a step.
    const workspace = await validateWorkspace(input.workspace, this.config.allowed_workspaces);
    // One spelling for the whole record. `assertPlan` proved every step names the mission's workspace, so rewriting
    // it to the canonical directory loses nothing — and keeping the raw string would make `mission_plan` print two
    // spellings of one directory, which `extend` would then refuse the client for using.
    const steps = input.steps.map(step => ({...step, delegate: {...step.delegate, workspace}}));
    const now = new Date().toISOString();
    const mission: Mission = {
      mission_id: randomUUID(), title: redact(input.title), goal: redact(input.goal), workspace,
      status: 'open', client: meta.client ? redact(meta.client).slice(0, 100) : null,
      created_at: now, updated_at: now, canceled_at: null, steps: toSteps(steps)
    };
    this.missions.set(mission.mission_id, mission);
    for (const evicted of this.makeRoom()) await this.forget(evicted);
    await this.persist(mission);
    return mission;
  }

  /** Add steps to a plan that is still open. Existing steps are never rewritten. */
  async extend(id: string, steps: unknown): Promise<Mission> {
    const mission = this.require(id);
    if (mission.status === 'canceled') throw new Error(`mission ${id} is canceled; its plan can no longer change`);
    const additions = await this.alignWorkspaces(stepsSchema.parse(steps), mission.workspace);
    assertPlan(additions, mission.steps, mission.workspace, this.config.max_timeout_seconds);
    mission.steps.push(...toSteps(additions));
    mission.updated_at = new Date().toISOString();
    await this.persist(mission);
    return mission;
  }

  /**
   * Resolve each distinct workspace spelling of an incoming plan against the mission's own directory, so the
   * single-workspace rule gates on the directory rather than on how the client wrote it: a trailing separator,
   * slashes the other way or a Windows short name all name a workspace the plan already runs in, and `dispatch`
   * canonicalizes the same string anyway. Only a spelling that lands on this mission's directory is rewritten;
   * anything else stays exactly as the client wrote it so `assertPlan` refuses it with the plan's own message.
   */
  private async alignWorkspaces(steps: MissionStepInput[], workspace: string): Promise<MissionStepInput[]> {
    const lands = new Map<string, boolean>();
    for (const candidate of new Set(steps.map(step => step.delegate.workspace))) {
      if (candidate === workspace) { lands.set(candidate, true); continue; }
      const resolved = await validateWorkspace(candidate, this.config.allowed_workspaces).catch(() => null);
      lands.set(candidate, resolved === workspace);
    }
    return steps.map(step => lands.get(step.delegate.workspace) ? {...step, delegate: {...step.delegate, workspace}} : step);
  }

  /**
   * Starts the one step the caller names, with the arguments recorded in its plan entry. The bridge never picks the
   * next step itself: readiness is checked here, so a dependency that did not complete cannot be skipped past.
   */
  async dispatch(missionId: string, stepId: string, meta: {client?: string | null} = {}): Promise<{mission: Mission; step: MissionStep; task: Task}> {
    const mission = this.require(missionId);
    const step = mission.steps.find(item => item.step_id === stepId);
    if (!step) throw new Error(`mission ${missionId} has no step "${stepId}"`);
    if (mission.status === 'canceled') throw new Error(`mission ${missionId} is canceled: no step can be dispatched`);
    const states = this.states(mission);
    if (step.task_id) throw new Error(`step "${stepId}" is already bound to task ${step.task_id} (${states.get(stepId)}); the plan is append-only, so dispatch a new step to try again`);
    const unmet = step.depends_on.filter(dependency => states.get(dependency) !== 'completed');
    if (unmet.length) throw new Error(`step "${stepId}" is not ready: ${unmet.map(dependency => `"${dependency}" is ${states.get(dependency)}`).join(', ')}`);
    const key = `${missionId}/${stepId}`;
    if (this.inFlight.has(key)) throw new Error(`step "${stepId}" is already being dispatched by another call`);
    this.inFlight.add(key);
    try {
      const task = await this.tasks.delegate({...step.delegate}, {client: meta.client ?? `mission ${missionId}/${stepId}`});
      step.task_id = task.task_id;
      mission.updated_at = new Date().toISOString();
      await this.persist(mission);
      return {mission, step, task};
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Stops the plan: nothing further can be dispatched. Running agents are left alone unless asked, because stopping a
   * process mid-edit is the caller's decision and `antigravity_cancel_task` is the tool for it.
   */
  async cancel(id: string, options: {cancelRunningTasks?: boolean} = {}): Promise<{mission: Mission; running: string[]; canceled: string[]}> {
    const mission = this.require(id);
    const states = this.states(mission);
    const running = mission.steps
      .filter(step => step.task_id && (states.get(step.step_id) === 'queued' || states.get(step.step_id) === 'running'))
      .map(step => step.task_id as string);
    const canceled: string[] = [];
    if (mission.status !== 'canceled') {
      mission.status = 'canceled';
      mission.canceled_at = new Date().toISOString();
      mission.updated_at = mission.canceled_at;
      await this.persist(mission);
    }
    // Asking for the agents to stop is a separate decision from closing the plan, so it stays honoured after a first cancel.
    if (options.cancelRunningTasks) {
      for (const taskId of running) {
        const stopped = await this.tasks.cancel(taskId).catch(() => undefined);
        if (stopped?.status === 'canceled') canceled.push(taskId);
      }
    }
    return {mission, running, canceled};
  }

  /** Cheap progress view: no task text and no logs, one short entry per step. */
  view(id: string): MissionView { return this.viewOf(this.require(id), false); }
  /** The whole plan with each step's delegate arguments, for an orchestrator that has lost its own copy. */
  planOf(id: string): MissionPlan { return this.viewOf(this.require(id), true) as MissionPlan; }

  list(): MissionView[] {
    return [...this.missions.values()]
      .map(mission => this.viewOf(mission, false))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }

  overview(): {open: number; canceled: number; steps: number; ready: number} {
    let open = 0, canceled = 0, steps = 0, ready = 0;
    for (const mission of this.missions.values()) {
      mission.status === 'open' ? open++ : canceled++;
      const view = this.viewOf(mission, false);
      steps += view.progress.total;
      ready += view.ready.length;
    }
    return {open, canceled, steps, ready};
  }

  private require(id: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new Error('Unknown or expired mission_id');
    return mission;
  }

  /**
   * Task-derived state for a bound step, then readiness for the rest. A step can only reach `completed` through its
   * own task, so an unbound dependency never satisfies readiness and one pass settles every state.
   */
  private states(mission: Mission): Map<string, StepState> {
    const states = new Map<string, StepState>();
    for (const step of mission.steps) {
      if (!step.task_id) continue;
      try { states.set(step.step_id, this.tasks.summary(step.task_id).status); }
      catch { states.set(step.step_id, 'lost'); }
    }
    for (const step of mission.steps) {
      if (states.has(step.step_id)) continue;
      states.set(step.step_id, step.depends_on.some(dependency => states.get(dependency) !== 'completed') ? 'pending' : 'ready');
    }
    return states;
  }

  private viewOf(mission: Mission, withArgs: boolean): MissionView {
    const states = this.states(mission);
    const steps = mission.steps.map(step => {
      const state = states.get(step.step_id) as StepState;
      const summary: TaskSummary | null = step.task_id ? this.summaryOrNull(step.task_id) : null;
      return {
        step_id: step.step_id, title: step.title, state, depends_on: [...step.depends_on],
        blocked_by: state === 'pending'
          ? step.depends_on.filter(dependency => states.get(dependency) !== 'completed').map(dependency => ({step_id: dependency, state: states.get(dependency) as StepState}))
          : [],
        task_id: step.task_id, agent: step.delegate.agent ?? null, isolation: step.delegate.isolation,
        scope: summary?.scope ? {checked: summary.scope.checked, changed: summary.scope.changed, out_of_scope: summary.scope.out_of_scope.length} : null,
        ...(withArgs ? {delegate: step.delegate} : {})
      };
    });
    const count = (test: (state: StepState) => boolean) => steps.filter(step => test(step.state)).length;
    const terminal = (state: StepState) => state !== 'completed' && state !== 'ready' && state !== 'pending' && state !== 'queued' && state !== 'running';
    return {
      mission_id: mission.mission_id, title: mission.title, workspace: mission.workspace, status: mission.status,
      created_at: mission.created_at, updated_at: mission.updated_at,
      ...(withArgs ? {goal: mission.goal, client: mission.client} : {}),
      progress: {
        total: steps.length,
        completed: count(state => state === 'completed'),
        active: count(state => state === 'queued' || state === 'running'),
        ready: count(state => state === 'ready'),
        pending: count(state => state === 'pending'),
        unmet: count(terminal)
      },
      ready: steps.filter(step => step.state === 'ready').map(step => step.step_id),
      steps
    };
  }

  private summaryOrNull(id: string): TaskSummary | null {
    try { return this.tasks.summary(id); } catch { return null; }
  }

  /** Retention only ever releases a mission with no task in flight, so a plan cannot vanish under a running agent. */
  private makeRoom(): string[] {
    const evicted: string[] = [];
    while (this.missions.size > MAX_RETAINED_MISSIONS) {
      const candidates = [...this.missions.values()]
        .filter(mission => {
          const states = this.states(mission);
          return ![...states.values()].some(state => state === 'queued' || state === 'running');
        })
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      if (!candidates.length) return evicted;
      const [oldest] = candidates;
      this.missions.delete(oldest.mission_id);
      evicted.push(oldest.mission_id);
      console.error(`[bridge] Dropped the oldest mission record ${oldest.mission_id} to keep ${MAX_RETAINED_MISSIONS} missions`);
    }
    return evicted;
  }

  /** Best effort, like task history: a lost write costs the resume, not the running plan. */
  private async persist(mission: Mission): Promise<void> {
    const file = path.join(this.missionsDirectory, `${mission.mission_id}.json`);
    try {
      await mkdir(this.missionsDirectory, {recursive: true, mode: 0o700});
      await writeFile(`${file}.tmp`, JSON.stringify({mission}), {mode: 0o600});
      // The web UI and a polling client open these records for reading; Windows refuses a rename onto a held file.
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 2 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      await unlink(`${file}.tmp`).catch(() => undefined);
    }
  }

  private async forget(id: string): Promise<void> {
    await unlink(path.join(this.missionsDirectory, `${id}.json`)).catch(() => undefined);
  }

  /**
   * Reloads plans after a restart. Step state is derived from the task records on every read rather than stored, so a
   * task that the restart marked failed shows up as failed here too, and no step is ever re-dispatched on its own.
   */
  async restore(): Promise<number> {
    let names: string[];
    try { names = (await readdir(this.missionsDirectory)).filter(name => MISSION_FILE.test(name)); } catch { return 0; }
    const loaded: Mission[] = [];
    for (const name of names) {
      try {
        const {mission} = recordSchema.parse(JSON.parse(await readFile(path.join(this.missionsDirectory, name), 'utf8')));
        if (`${mission.mission_id}.json` !== name) continue;
        loaded.push(mission);
      } catch { /* a record this project did not write is left where it is, never loaded */ }
    }
    loaded.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    for (const mission of loaded.slice(MAX_RETAINED_MISSIONS)) await this.forget(mission.mission_id);
    for (const mission of loaded.slice(0, MAX_RETAINED_MISSIONS)) this.missions.set(mission.mission_id, mission);
    return this.missions.size;
  }
}
