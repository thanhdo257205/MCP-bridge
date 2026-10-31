import type { ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { Config } from '../config.js';
import { DEFAULT_MAX_WAIT_SECONDS, delegateSchema, promptFor, type DelegateInput, type DelegateRequest } from '../security/input.js';
import { inside, validateWorkspace } from '../security/workspace.js';
import { appendDecision } from '../decisions.js';
import { applyWorktreeChanges, repositoryRoot } from '../isolation/apply.js';
import { worktreeFileDiff, type FileDiff } from '../isolation/diff.js';
import { redact } from '../security/redact.js';
import { delegationState } from '../delegation.js';
import { startProcess, terminateOwned, type ProcessOptions } from '../antigravity/process.js';
import {legacyAntigravityAgent} from '../agents/antigravity.js';
import type {AgentRuntime, Autonomy, Isolation, PublicAgentStatus} from '../agents/types.js';
import {createWorktree, inspectScope, removeWorktree, type ScopeReport, type Worktree} from '../isolation/worktree.js';
import {reapOwnedTree, type ProcessInfo, type TreeReport, type TreeWatch} from '../isolation/orphans.js';
import type {PromptTransport} from '../antigravity/invocation.js';
import {appendUsage,totalTokens,type TaskStats} from '../usage.js';
import {MAX_RECENT_STEPS,rawStep,readProgress,summarizeStep,type Step} from '../progress.js';
import {helperDirectory} from '../paths.js';
import {readWait} from '../wait-setting.js';
import {CHECK_DELAYS_SECONDS,readSoftTimeout,rampedWaitSeconds} from '../soft-timeout.js';
import {effortFlags,readEffort,type EffortLevel} from '../effort.js';
import {lowerLevel,permissionFlags,permissionState,type PermissionLevel} from '../permissions.js';
import {listModels,readModel,type ModelInfo} from '../models.js';
import {pidAlive, recoverExecutionLock} from './execution-lock.js';
import { globalHealthTracker, isHardTask } from '../agents/quota.js';
import { XerjClient } from '../xerj/client.js';

export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'canceled' | 'unsupported';
export interface Task {
  task_id: string; workspace: string; status: Status; started_at: string; queued_at: string | null; ended_at: string | null;
  duration_ms: number; pid: number | null; process_running: boolean;
  agent: string; isolation: Isolation; worktree: string | null; branch: string | null; owns: string[]; autonomy: Autonomy;
  /** Repository root the worktree was added to; a startup sweep needs it to drop the git admin record too. */
  worktree_toplevel?: string | null;
  scope: ScopeReport | null;
  /** When the owner brought this task's changes into the workspace, and which files (absent until then). */
  applied_at?: string | null;
  applied_files?: string[];
  /** When the owner threw the worktree away without or after applying it. */
  discarded_at?: string | null;
  /** Processes the agent left holding the worktree directory after it exited (null when nothing was found). */
  cleanup?: TreeReport | null;
  exit_code: number | null; signal: string | null; stdout: string; stderr: string;
  stdout_bytes: number; stderr_bytes: number; stdout_truncated: boolean; stderr_truncated: boolean;
  final_response: string | null; cli_status: string | null; error: string | null;
  denied_actions: {action: string; display_name: string}[];
  /** Attempts a quota failover abandoned before this one, each with the reason it stopped (absent when there was no failover). */
  attempts?: TaskAttempt[];
  review_required: true; acceptance_verified: false;
}
/** One agent attempt that was given up on and replaced by another profile in the same pool. */
export interface TaskAttempt {
  agent: string; status: Status; error: string | null; exit_code: number | null; signal: string | null;
  ended_at: string | null; duration_ms: number; stdout_tail: string; stderr_tail: string;
  /** A worktree task only: what this attempt had changed when it was given up on. The retry reuses the worktree, so the final scope is the sum of every attempt. */
  scope?: ScopeReport;
  /** The process trees this attempt left behind and the bridge released before the retry started. */
  cleanup?: TreeReport;
}
/** How much of an abandoned attempt's log is kept: enough to show why it stopped, small enough not to multiply the record. */
const ATTEMPT_TAIL_CHARS = 4000;
const tail = (text: string): string => (text.length > ATTEMPT_TAIL_CHARS ? text.slice(-ATTEMPT_TAIL_CHARS) : text);
export type TaskSummary = Omit<Task, 'stdout' | 'stderr' | 'final_response' | 'attempts'>;
const TASK_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
/** A finished task publishes its status as soon as this budget runs out, even if the process query is wedged. */
const REAP_BUDGET_MS = 6000;
/** What the Tech Lead asked for. Kept beside the task (not in it) so MCP responses stay small; shown in the web UI. */
export interface TaskRequest {
  task: string; acceptance_criteria: string[]; context: string | null; timeout_seconds: number; client?: string | null;
  agent?: string; isolation?: Isolation; owns?: string[]; autonomy?: Autonomy; worktree?: string | null; branch?: string | null;
  /** Model chosen in the web UI when the task was accepted (null: Antigravity's own default). Absent in older records. */
  model?: string | null;
  /** Antigravity permission level this task ran (or will run) with; absent in older records. */
  permission?: PermissionLevel;
  /** Reasoning effort the task was accepted with ('default': no --effort flag); absent in older records. */
  effort?: EffortLevel;
}
interface Entry {
  task: Task; request?: TaskRequest; child?: ChildProcess; done: Promise<void>; stop?: Status;
  lane?: 'normal' | 'worktree';
  /** Resolves `done`; set for every task that goes through the CLI. */
  finish?: () => void;
  /** Validated input and the resolved agent kept until the process starts (a queued task waits with it). */
  pending?: {input: DelegateInput; workspace: string; timeout: number; agent: AgentRuntime; autonomy: Autonomy};
  poolId?: string;
  poolTried?: Set<string>;
  worktreeInfo?: Worktree;
  holdsLock?: boolean;
  /** When the process last wrote to stdout/stderr (live signal that it is still working; not persisted). */
  lastOutputAt?: number;
  /** Log file agy was asked to write (only when the soft deadline is on); its modification time is a liveness signal. */
  logFile?: string;
  /** Soft deadline state, shown in the web UI: how often the task was extended, when the next check is due, and the absolute limit. */
  soft?: {extensions: number; nextCheckAt: number | null; hardLimitAt: number};
  /** What agy's own result says about this task's cost (usage, duration, turns); persisted with the task. */
  stats?: TaskStats;
  /** Steps agy reported while it ran (step progress setting): how many, and the most recent ones. Kept in memory only. */
  steps?: {total: number; recent: Step[]};
  /** Waits a client asked for without choosing a length; they get longer each time (see rampedWaitSeconds). */
  bareWaits?: number;
}
export interface Runtime {
  executable: string; supported: boolean; stateDirectory: string;
  /** Args every Antigravity command needs before its own (the .js entry of a resolved Windows shim). */
  prefixArgs?: string[];
  launch?: (args: string[], cwd: string, options?:ProcessOptions) => ChildProcess;
  agents?: AgentRuntime[];
  defaultAgent?: string | null;
  /** Test hooks: grace after the deadline before the first check (default 10s) and the delays between soft-deadline checks (default 1, 5, 10 minutes). */
  deadlineGraceMs?: number; softCheckDelaysMs?: number[]; progressIntervalMs?: number;
  /** Replaces running `agy models` (tests). */
  models?: () => Promise<ModelInfo[]>;
  /** Replaces the owned-process-tree release (tests, and hosts that forbid process enumeration). */
  reapTree?: (pid: number, options: {started_at_ms: number; observed: ProcessInfo[]}) => Promise<TreeReport>;
  watchTree?: (pid: number) => TreeWatch;
}

export class TaskManager {
  private entries = new Map<string, Entry>();
  private busy = false;
  private worktreeRunning = 0;
  private queue: string[] = [];
  private admission: Promise<void> = Promise.resolve();
  private closing = false;
  /** Tree releases still running after their task published its status; shutdown waits for these. */
  private pendingRelease = new Set<Promise<void>>();
  private readonly agents: AgentRuntime[];
  private readonly defaultAgent: string | null;
  private xerjClient: XerjClient;
  constructor(private config: Config, private runtime: Runtime) {
    this.agents = runtime.agents?.length
      ? runtime.agents
      : [legacyAntigravityAgent(runtime, config.prompt_transport)];
    this.defaultAgent = runtime.defaultAgent ?? this.agents.find(agent => agent.enabled && agent.status.available)?.adapter.id ?? null;
    this.xerjClient = new XerjClient({ url: config.xerj?.url, defaultIndex: config.xerj?.default_index });
  }

  getXerjClient(): XerjClient { return this.xerjClient; }
  setXerjClient(client: XerjClient): void { this.xerjClient = client; }
  /** XERJ is opt-in: without it the bridge never puts task text in front of another local service, and never puts a retrieved passage into a prompt. */
  isXerjEnabled(): boolean { return this.config.xerj?.enabled === true; }

  private get maxParallelWorktrees(): number { return this.config.max_parallel_worktrees ?? 2; }
  private selectAgent(id?: string, taskInput?: DelegateInput): AgentRuntime {
    const pools = this.config.agents?.pools ?? {};
    const targetPoolId = (id && pools[id]) ? id : (!id && this.defaultAgent && pools[this.defaultAgent] ? this.defaultAgent : undefined);
    if (targetPoolId) {
      const pool = pools[targetPoolId];
      const isHard = taskInput ? isHardTask(taskInput) : false;
      const pickedId = globalHealthTracker.selectProfile(
        pool,
        isHard,
        (candId) => this.agents.some(a => a.adapter.id === candId && a.enabled && a.status.available)
      );
      if (pickedId) {
        const found = this.agents.find(a => a.adapter.id === pickedId);
        if (found) return found;
      }
      // The pool exists; it is its members that are out. Falling through would call a real pool an "Unknown agent".
      if (id !== undefined && !this.agents.some(item => item.adapter.id === id)) {
        throw new Error(`Pool "${id}" has no healthy member right now (members: ${pool.members.join(', ')}); a member in cooldown or unavailable is skipped. Check agents_list or retry later`);
      }
    }
    if (id !== undefined) {
      const agent = this.agents.find(item => item.adapter.id === id);
      if (!agent) throw new Error(`Unknown agent "${id}". Known agents: ${this.agents.map(item => item.adapter.id).join(', ')}`);
      if (!agent.enabled) throw new Error(`Agent "${id}" is disabled in the bridge config`);
      if (!agent.status.available) throw new Error(`Agent "${id}" is not available: ${agent.status.warnings[0] ?? 'CLI was not detected'}`);
      return agent;
    }
    const preferred = this.defaultAgent ? this.agents.find(agent => agent.adapter.id === this.defaultAgent) : undefined;
    if (preferred?.enabled && preferred.status.available) return preferred;
    const fallback = this.agents.find(agent => agent.enabled && agent.status.available);
    if (fallback) return fallback;
    throw new Error('No enabled agent CLI is available. Check the bridge config and install an agent CLI');
  }
  private canStart(isolation: Isolation): boolean {
    return isolation === 'worktree'
      ? !this.busy && this.worktreeRunning < this.maxParallelWorktrees
      : !this.busy && this.worktreeRunning === 0;
  }
  private occupy(entry: Entry): void {
    entry.lane = entry.task.isolation === 'worktree' ? 'worktree' : 'normal';
    if (entry.lane === 'worktree') this.worktreeRunning++; else this.busy = true;
  }
  private release(entry: Entry): void {
    if (entry.lane === 'worktree') this.worktreeRunning = Math.max(0, this.worktreeRunning - 1);
    else if (entry.lane === 'normal') this.busy = false;
    entry.lane = undefined;
  }
  agentsOverview(): {agents: PublicAgentStatus[]; default_agent: string | null; max_parallel_worktrees: number} {
    return {
      agents: this.agents.map(({adapter, status, enabled}) => ({
        id: adapter.id, label: adapter.label, enabled, available: status.available, version: status.version,
        executable: status.executable, capabilities: adapter.capabilities, warnings: status.warnings
      })),
      default_agent: this.defaultAgent,
      max_parallel_worktrees: this.maxParallelWorktrees
    };
  }

  /** Calls are admitted strictly in the order they arrive: workspace validation is asynchronous and must not let a later call overtake an earlier one. */
  delegate(raw: DelegateRequest, meta: {client?: string | null} = {}): Promise<Task> {
    const admitted = this.admission.then(() => this.admit(raw, meta));
    this.admission = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  private async admit(raw: DelegateRequest, meta: {client?: string | null}): Promise<Task> {
    if (this.closing) throw new Error('Bridge is shutting down');
    const delegation = delegationState(this.runtime.stateDirectory);
    if (!delegation.enabled) throw new Error(`Delegation to Antigravity is disabled by the bridge owner (${delegation.reason}). Do not delegate; do this work yourself or ask the user to run \`agy-mcp-bridge delegation on\` (\`npm run delegation -- on\` in a git checkout)`);
    const input = delegateSchema.parse(raw);
    const timeout = input.timeout_seconds ?? this.config.default_timeout_seconds;
    if (timeout > this.config.max_timeout_seconds) throw new Error('Timeout exceeds configured maximum');
    const workspace = await validateWorkspace(input.workspace, this.config.allowed_workspaces);
    if (this.closing) throw new Error('Bridge is shutting down');

    let agent: AgentRuntime | undefined;
    if (input.agent !== undefined) agent = this.selectAgent(input.agent, input);
    else try { agent = this.selectAgent(undefined, input); } catch { agent = undefined; }
    const supported = Boolean(agent?.status.available);
    const autonomy = input.autonomy ?? this.config.default_autonomy ?? 'auto';

    // Everything from here to the registration of the entry is synchronous, so concurrent callers cannot both claim a slot.
    // Ordinary tasks are serialized globally; worktree tasks may run in parallel up to max_parallel_worktrees.
    const queued = supported && !this.canStart(input.isolation);
    if (queued && this.queue.length >= this.config.max_queued_tasks) {
      throw new Error(this.config.max_queued_tasks > 0 ? 'Bridge is busy with another task and the queue is full' : 'Bridge is busy with another task');
    }
    const evicted: string[] = [];
    while (this.entries.size >= this.config.max_retained_tasks) {
      const oldest = [...this.entries].find(([, value]) => value.task.status !== 'running' && value.task.status !== 'queued');
      if (!oldest) throw new Error('Task retention capacity reached');
      this.entries.delete(oldest[0]);
      evicted.push(oldest[0]);
    }
    const now = new Date().toISOString();
    const task: Task = {
      task_id: randomUUID(), workspace, status: !supported ? 'unsupported' : queued ? 'queued' : 'running',
      started_at: now, queued_at: queued ? now : null, ended_at: null, duration_ms: 0,
      pid: null, process_running: false,
      agent: agent?.adapter.id ?? input.agent ?? this.defaultAgent ?? 'none',
      isolation: input.isolation, worktree: null, branch: null, owns: input.owns, autonomy, scope: null,
      exit_code: null, signal: null,
      stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0,
      stdout_truncated: false, stderr_truncated: false,
      final_response: null, cli_status: null, error: null, denied_actions: [], review_required: true, acceptance_verified: false
    };
    const pools = this.config.agents?.pools ?? {};
    const poolId = (input.agent && pools[input.agent]) ? input.agent : (!input.agent && this.defaultAgent && pools[this.defaultAgent] ? this.defaultAgent : undefined);
    const entry: Entry = {
      poolId,
      task, done: Promise.resolve(), pending: supported ? {input, workspace, timeout, agent: agent!, autonomy} : undefined,
      request: {
        task: redact(input.task), acceptance_criteria: input.acceptance_criteria.map(redact),
        context: input.context === undefined ? null : redact(input.context), timeout_seconds: timeout,
        client: meta.client ? redact(meta.client).slice(0, 100) : null,
        agent: task.agent, isolation: input.isolation, owns: input.owns, autonomy,
        model: agent?.adapter.family === 'antigravity' ? await readModel(this.runtime.stateDirectory) : null,
        permission: permissionState(this.runtime.stateDirectory).level,
        effort: readEffort(this.runtime.stateDirectory)
      }
    };
    this.entries.set(task.task_id, entry);
    if (supported) {
      entry.done = new Promise<void>(resolve => { entry.finish = resolve; });
      if (queued) this.queue.push(task.task_id); else this.occupy(entry);
    }
    await Promise.all(evicted.map(id => this.forget(id)));
    await this.persist(task);

    if (!supported) {
      task.ended_at = new Date().toISOString();
      task.error = input.agent !== undefined
        ? `Agent "${input.agent}" is not available`
        : 'No enabled agent CLI is available. Check the bridge config and install an agent CLI';
      return this.get(task.task_id);
    }
    if (queued) return this.get(task.task_id);
    try { await this.launch(entry); }
    catch (error) {
      this.entries.delete(task.task_id);
      await this.forget(task.task_id);
      entry.finish?.();
      this.release(entry);
      throw error;
    }
    return this.get(task.task_id);
  }

  /** Starts the process for an entry that already owns its lane. Throws only before the process exists. */
  private async launch(entry: Entry): Promise<void> {
    const {task} = entry;
    const {input, workspace, timeout, agent, autonomy} = entry.pending!;
    let ownsLock = Boolean(entry.holdsLock);
    let worktree: Worktree | null = entry.worktreeInfo ?? null;
    let execWorkspace = workspace;
    const lock = path.join(this.runtime.stateDirectory, 'execution.lock');
    try {
      if (this.closing) throw new Error('Bridge is shutting down');
      if (task.queued_at) {
        try { await validateWorkspace(workspace, this.config.allowed_workspaces); }
        catch (error) { throw new Error(`Queued workspace validation failed before execution: ${error instanceof Error ? error.message : 'invalid workspace'}`); }
      }
      await mkdir(this.runtime.stateDirectory, { recursive: true });
      if (task.isolation === 'worktree') {
        if (!worktree) {
          worktree = await createWorktree({workspace, stateDirectory: this.runtime.stateDirectory, taskId: task.task_id});
          entry.worktreeInfo = worktree;
          task.worktree = worktree.root;
          task.branch = worktree.branch;
          task.worktree_toplevel = worktree.toplevel;
          if (entry.request) { entry.request.worktree = worktree.workspace; entry.request.branch = worktree.branch; }
        }
        execWorkspace = worktree.workspace;
        task.worktree = worktree.root;
        task.branch = worktree.branch;
        task.worktree_toplevel = worktree.toplevel;
        // Keep the regenerated prompt equal to the one the agent received (the worktree workspace, not the original one).
        if (entry.request) { entry.request.worktree = worktree.workspace; entry.request.branch = worktree.branch; }
      } else if (!ownsLock) {
        try { await mkdir(lock); ownsLock = true; }
        catch {
          const recovery=await recoverExecutionLock(this.runtime.stateDirectory);
          if(!recovery.reclaimed)throw new Error(await this.describeLock(lock));
          await mkdir(lock);ownsLock=true;
        }
      }
      entry.holdsLock = ownsLock;
      const checkStarting = () => {
        if (this.closing || entry.stop === 'canceled' || task.status === 'canceled') throw new Error('Canceled before execution');
      };
      checkStarting();
      // Persist the transition before spawning: after a crash we must not claim queued work never ran.
      task.status = 'running';
      task.started_at = new Date().toISOString();
      await this.persist(task);
      checkStarting();
      const promptInput = {...input, workspace: execWorkspace, autonomy};
      // Both flags, not just auto_reference: a passage retrieved from the index is appended to the prompt the agent
      // follows, so an index hit becomes an instruction the client never sent. The owner opts in twice, on purpose.
      if (this.isXerjEnabled() && this.config.xerj?.auto_reference) {
        try {
          const searchRes = await this.xerjClient.search(input.task, {
            limit: this.config.xerj?.max_passages ?? 3
          });
          if (searchRes.available && searchRes.hits.length > 0) {
            const referenceBlock = this.xerjClient.formatPassagesForPrompt(searchRes.hits);
            if (referenceBlock) {
              promptInput.context = promptInput.context
                ? `${promptInput.context}\n\n${referenceBlock}`
                : referenceBlock;
            }
          }
        } catch {
          // Best-effort auto-reference
        }
      }
      // The level in force when the task was accepted, or the current one if the owner has lowered it since: lowering applies to queued tasks too, raising never does.
      const permission=lowerLevel(entry.request?.permission??'default',permissionState(this.runtime.stateDirectory).level);
      if(entry.request)entry.request.permission=permission;
      // Soft deadline (owner setting, off by default): agy gets the absolute limit as its own print timeout and a log file whose growth shows it is alive.
      const soft=readSoftTimeout(this.runtime.stateDirectory);
      const antigravity = agent.adapter.family === 'antigravity';
      const absoluteLimit=Math.max(timeout,soft.limit_seconds);
      let logFile:string|undefined;
      if(antigravity&&soft.enabled){
        const logDirectory=path.join(this.runtime.stateDirectory,'agy-logs');
        await mkdir(logDirectory,{recursive:true});
        logFile=path.join(logDirectory,`${task.task_id}.log`);
      }
      // Step progress (owner setting): Antigravity streams events instead of one JSON at the end; other agents keep their own protocol.
      const transport: PromptTransport|undefined = antigravity
        ? (this.config.prompt_transport === 'stdin' ? 'stdin' : readProgress(this.runtime.stateDirectory).enabled ? 'argv-stream' : 'argv')
        : undefined;
      const extraArgs = antigravity
        ? [...permissionFlags(permission),...effortFlags(entry.request?.effort??'default'),...(logFile?['--log-file',logFile]:[])]
        : [];
      const invocation = agent.adapter.buildInvocation({
        prompt: promptFor(promptInput, entry.request?.client), workspace: execWorkspace,
        timeoutSeconds: antigravity&&soft.enabled?absoluteLimit:timeout,
        autonomy, owns: task.owns, taskId: task.task_id, stateDirectory: this.runtime.stateDirectory,
        // The task's model is a per-family setting: a codex model handed to another family would override that family's own.
        model: antigravity ? entry.request?.model ?? null : agent.adapter.family === 'codex' ? this.config.agents?.codex_model : undefined,
        extraArgs, promptTransport: transport
      });
      if (invocation.resultFile) await mkdir(path.dirname(invocation.resultFile), {recursive: true});
      const compactLine = agent.adapter.compactLine?.bind(agent.adapter);
      const streaming = (invocation.transport !== undefined && invocation.transport !== 'argv') || compactLine !== undefined;
      const options = {extraEnvPassthrough: this.config.extra_env_passthrough, stdin: invocation.stdin, customEnv: invocation.customEnv};
      const child = agent.launch
        ? agent.launch(invocation.args, execWorkspace, options)
        : startProcess(invocation.executable, [...(agent.prefixArgs ?? []), ...invocation.args], execWorkspace, options);
      entry.child = child;
      entry.pending = undefined;
      task.status = 'running';
      task.started_at = new Date().toISOString();
      task.pid = child.pid ?? null;
      task.process_running = Boolean(child.pid);
      const started = Date.now();
      // Windows keeps a exited process's children addressed by their parent's pid, and that parent is often a shell
      // that dies before the agent does, so the tree has to be recorded while the agent runs (500–10000 ms polls). The runtime owns the
      // watcher: a task manager built without one releases only what a final process query can still attribute to it.
      const watch = this.runtime.watchTree?.(child.pid ?? 0) ?? {stop: () => [] as ProcessInfo[]};
      const buffers = {stdout: [] as Buffer[], stderr: [] as Buffer[]};
      const lengths={stdout:0,stderr:0};
      const dirty={stdout:false,stderr:false};
      const refreshed={stdout:0,stderr:0};
      const flushOutput=(force=false)=>{
        const now=Date.now();
        for(const stream of ['stdout','stderr'] as const){
          if(dirty[stream]&&(force||now-refreshed[stream]>=1000)){
            task[stream]=redact(Buffer.concat(buffers[stream],lengths[stream]).toString('utf8'));
            dirty[stream]=false;refreshed[stream]=now;
          }
        }
      };
      let finalized = false;
      const requestStop = (reason: Status) => {
        if (!entry.stop) entry.stop = reason;
        void terminateOwned(child).catch(() => { task.error = 'Failed to terminate owned process tree; execution lock is retained until process closes'; });
      };
      // Keeps data for the task's stdout/stderr logs, within the output cap.
      const retain = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const available = this.config.max_output_bytes - lengths[stream];
        if (available > 0) {
          const retained=Buffer.from(chunk.subarray(0,available));
          buffers[stream].push(retained);lengths[stream]+=retained.length;dirty[stream]=true;
        }
        if (chunk.length > available) {
          task[`${stream}_truncated`] = true;
          task.error = 'Output limit exceeded; incomplete output cannot establish success';
          requestStop('failed');
        }
      };
      // Stream mode: stdout is one JSON event per line. step_update events become progress steps and are not kept in the log (they could
      // otherwise fill the output cap long before the final result); init, result and anything else are kept as before.
      const decoder = new StringDecoder('utf8');
      let partialLine = '';
      const takeStepLine = (line: string): boolean => {
        if (!line.trim()) return true;
        let event: unknown;
        try { event = JSON.parse(line); } catch { return false; }
        if (typeof event !== 'object' || event === null || (event as {event?: unknown}).event !== 'step_update') return false;
        const value = (event as {step_update?: unknown}).step_update;
        const steps = entry.steps ??= {total: 0, recent: []};
        steps.total += 1;
        steps.recent.push({n: steps.total, at: Date.now(), summary: summarizeStep(value), raw: rawStep(value)});
        if (steps.recent.length > MAX_RECENT_STEPS) steps.recent.shift();
        return true;
      };
      /** What of one complete stdout line is kept: nothing for a step event, else the adapter's compact form (or the line itself). */
      const keepLine = (line: string): string | null => {
        if (takeStepLine(line)) return null;
        if (!compactLine) return line;
        try { return compactLine(line); } catch { return line; }
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        entry.lastOutputAt = Date.now();
        task[`${stream}_bytes`] += chunk.length;
        let keep: Buffer = chunk;
        if (streaming && stream === 'stdout') {
          const lines = (partialLine + decoder.write(chunk)).split('\n');
          partialLine = lines.pop() ?? '';
          keep = Buffer.from(lines.map(keepLine).filter((line): line is string => line !== null).map(line => `${line}\n`).join(''));
          // A line that never ends must not grow without bound: treat an oversized one as ordinary output (and so as an overflow).
          if (partialLine.length > this.config.max_output_bytes) { keep = Buffer.concat([keep, Buffer.from(partialLine)]); partialLine = ''; }
        }
        if (keep.length) retain(stream, keep);
        flushOutput();
      };
      child.stdout!.on('data', (data: Buffer) => capture('stdout', data));
      child.stderr!.on('data', (data: Buffer) => capture('stderr', data));
      const graceMs=this.runtime.deadlineGraceMs??10000;
      let timer: NodeJS.Timeout;
      if (!soft.enabled) timer = setTimeout(() => requestStop('timeout'), timeout * 1000 + graceMs);
      else {
        entry.logFile = logFile;
        const delays=(this.runtime.softCheckDelaysMs??CHECK_DELAYS_SECONDS.map(seconds=>seconds*1000));
        const hardLimitAt=started+absoluteLimit*1000+graceMs;
        entry.soft={extensions:0,nextCheckAt:null,hardLimitAt};
        let step=0;
        // At the deadline and then after 1, 5 and every 10 minutes: extend while there was activity in the window since the last check.
        const check = () => {
          const now=Date.now();
          const window=delays[Math.min(step,delays.length-1)];
          const idle=now-this.lastActivity(entry);
          if (now>=hardLimitAt) { task.error=`Stopped at the absolute limit of ${absoluteLimit}s; the task was still running`; requestStop('timeout'); return; }
          if (idle>window) { task.error=`No sign of activity for ${Math.round(Math.min(idle,now-started)/1000)}s after the ${timeout}s deadline; stopped`; requestStop('timeout'); return; }
          step+=1; entry.soft!.extensions+=1;
          const delay=Math.max(1,Math.min(delays[Math.min(step,delays.length-1)],hardLimitAt-now));
          entry.soft!.nextCheckAt=now+delay;
          timer=setTimeout(check,delay);
        };
        timer = setTimeout(check, timeout * 1000 + graceMs);
        entry.soft.nextCheckAt=started+timeout*1000+graceMs;
      }
      const outputTimer=setInterval(()=>flushOutput(),1000);
      child.once('error', () => { task.error = `Could not start ${agent.adapter.label} process`; });
      // Not awaited: no await may sit between spawn and the listeners above, or an early 'error' event would go unhandled.
      void writeFile(path.join(this.runtime.stateDirectory, 'owner.json'), JSON.stringify({server_pid: process.pid, child_pid: child.pid ?? null, task_id: task.task_id, started_at: task.started_at})).catch(() => {});
      child.once('close', async (code, signal) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timer);
        clearInterval(outputTimer);
        if (streaming) { const rest = partialLine + decoder.end(); partialLine = ''; if (rest.trim()) { const kept = keepLine(rest); if (kept !== null) retain('stdout', Buffer.from(kept)); } }
        flushOutput(true);
        const rawStdout=Buffer.concat(buffers.stdout,lengths.stdout).toString('utf8');
        const rawStderr=Buffer.concat(buffers.stderr,lengths.stderr).toString('utf8');
        // A POSIX child can exit while its group is still being given its graceful shutdown window.
        if (entry.stop) await terminateOwned(child).catch(() => { task.error = 'Owned process group cleanup failed'; });
        task.exit_code = code; task.signal = signal; task.process_running = false;
        task.ended_at = new Date().toISOString(); task.duration_ms = Date.now() - started;
        let finalStatus: Status = entry.stop ?? 'failed';
        if (!entry.stop) {
          try {
            const result = await agent.adapter.parseResult({
              stdout: rawStdout, stderr: rawStderr, exitCode: code, signal, resultFile: invocation.resultFile ?? null,
              transport: invocation.transport
            });
            if (result.stats) entry.stats = {...result.stats, steps: entry.steps?.total ?? null};
            task.cli_status = result.cliStatus;
            task.final_response = result.response === null ? null : redact(result.response);
            task.denied_actions = result.deniedActions.slice(0, 100).map(item => ({
              action: redact(item.action).slice(0, 200), display_name: redact(item.display_name).slice(0, 200)
            }));
            if (result.timeout) {
              finalStatus = 'timeout'; task.error = result.error ? redact(result.error) : 'CLI reported a timeout';
            } else if (result.success) {
              finalStatus = 'completed';
            } else {
              task.error = result.error ? redact(result.error) : `${agent.adapter.label} did not provide a complete successful response`;
              if (result.isQuotaExceeded) {
                const poolConfig = entry.poolId ? this.config.agents?.pools?.[entry.poolId] : undefined;
                const cooldown = poolConfig?.quota_cooldown_seconds ?? 900;
                globalHealthTracker.markCooldown(agent.adapter.id, cooldown);
                console.error(`[bridge] Agent profile "${agent.adapter.id}" exhausted quota/rate limit. Marked in cooldown (${cooldown}s).`);
                if (poolConfig) {
                  // Every profile this task already burned is excluded, so a pool of N gives at most N-1 retries and a
                  // pool that runs out fails the task instead of cycling through cooled members forever.
                  const tried = entry.poolTried ??= new Set([agent.adapter.id]);
                  const nextId = globalHealthTracker.selectProfile(
                    poolConfig,
                    isHardTask(input),
                    (candidateId) => this.agents.some(a => a.adapter.id === candidateId && a.enabled && a.status.available),
                    tried
                  );
                  const nextAgent = nextId ? this.agents.find(a => a.adapter.id === nextId) : undefined;
                  if (nextAgent && nextId) {
                    tried.add(nextId);
                    console.error(`[bridge] Task ${task.task_id} auto-failing over from "${agent.adapter.id}" to "${nextId}"...`);
                    // The first attempt's evidence survives the retry: the error, exit and output tails are what a
                    // reviewer needs to tell "quota exhausted" from "the agent did the work badly", and the next
                    // attempt's own flush overwrites task.stdout wholesale.
                    // The retry works in the same worktree, so whatever the abandoned attempt left behind stays in the diff;
                    // recording it now lets a reviewer tell that attempt's files from the next one's.
                    // What the abandoned agent left running is released first, and before the retry starts: a leftover MCP
                    // server or shell would otherwise keep the worktree pinned and could still write into the files the
                    // next attempt is about to work on.
                    const abandonedCleanup = await this.releaseAttemptTree(child.pid ?? null, started, watch);
                    let abandonedScope: ScopeReport | undefined;
                    if (worktree) { try { abandonedScope = await inspectScope(worktree, task.owns); } catch { /* the retry goes ahead without it */ } }
                    (task.attempts ??= []).push({
                      agent: agent.adapter.id, status: 'failed', error: task.error, exit_code: code, signal,
                      ended_at: task.ended_at, duration_ms: task.duration_ms,
                      stdout_tail: tail(task.stdout), stderr_tail: tail(task.stderr),
                      cleanup: abandonedCleanup,
                      ...(abandonedScope ? {scope: abandonedScope} : {})
                    });
                    entry.pending = {input, workspace, timeout, agent: nextAgent, autonomy};
                    task.agent = nextId;
                    task.error = null;
                    // The execution lock is deliberately NOT released here: this task still holds the lane, so the
                    // retry cannot let a second ordinary task in and a release can never delete a lock another task owns.
                    try { await this.launch(entry); return; }
                    catch (error) {
                      // Nobody awaits this callback, so a retry that cannot start must end the task here: left to reject, the
                      // task would stay "running" with no process while it keeps the lane. launch() already removed the
                      // lock it held; the finalization below runs for the attempt that did exit and records why it ended.
                      ownsLock = false; entry.holdsLock = false; entry.pending = undefined;
                      task.error = `Failover to "${nextId}" could not start: ${error instanceof Error ? redact(error.message) : 'unknown error'}`;
                    }
                  }
                }
              }
            }
          } catch (error) {
            task.error ??= error instanceof Error ? redact(error.message) : `Could not parse ${agent.adapter.label} output`;
          }
        }
        if (finalStatus === 'timeout') task.error ??= 'Task exceeded its execution deadline';
        if (finalStatus === 'canceled') task.error ??= 'Task canceled; partial file changes may remain';
        if (worktree) {
          try {
            task.scope = await inspectScope(worktree, task.owns);
            if (task.scope.out_of_scope.length) task.error ??= 'Files outside the declared owns scope were modified; review the worktree diff before merging';
          } catch (error) {
            task.scope = {checked: false, reason: error instanceof Error ? redact(error.message) : 'Could not inspect the worktree diff', changed: 0, out_of_scope: [], truncated: false};
          }
        }
        if (ownsLock) {
          try { await rmdir(lock); } catch { task.error ??= 'Could not release execution lock'; }
        }
        // The terminal status is written last: a reader that polls the moment the process exits must never see
        // "completed" while the owns-scope check on the worktree is still outstanding.
        task.status = finalStatus;
        await this.persist(task);
        // The agent launches its own children (MCP servers, shells, tool helpers) whose working directory is this
        // worktree, and on Windows they outlive it and pin the directory. Releasing them needs a process query, so
        // it runs after the status is visible: no client waits on it, and the record is patched when it finishes.
        const held = {request: entry.request ?? null, stats: entry.stats ?? null};
        // The last watch reading is part of the release, not of the publish chain: a wedged process query must not
        // hold the lane that the next queued task is waiting on.
        const release = Promise.resolve().then(() => watch.stop()).then(observed =>
          this.releaseOwnedTree(child.pid ?? null, started, observed)
        ).then(async cleanup => {
          task.cleanup = cleanup;
          // A report that reaped nothing and failed for no reason says nothing worth a second write: this one runs
          // detached from the status publish, so a reader of the tasks directory can catch its swap mid-flight.
          if (!cleanup.reaped.length && !cleanup.skipped.length && !cleanup.reason) return;
          // Retention can evict this task while the query is still running, and writing then would bring the record
          // back from the dead; only a task the manager still keeps has a record to patch.
          if (this.entries.has(task.task_id)) await this.persist(task, held);
        }).catch(() => { /* the release is a convenience; the task result stands without it */ });
        // Shutdown waits for whatever is still in flight here, so stopping the bridge right after the last agent
        // exits cannot drop the only record of which processes were left running.
        this.pendingRelease.add(release);
        void release.finally(() => { this.pendingRelease.delete(release); });
        await appendUsage(this.runtime.stateDirectory, {
          at: task.ended_at ?? new Date().toISOString(), status: task.status, model: entry.request?.model ?? null, effort: entry.request?.effort ?? null,
          permission: entry.request?.permission ?? null, duration_ms: task.duration_ms, agy_duration_seconds: entry.stats?.agy_duration_seconds ?? null,
          num_turns: entry.stats?.num_turns ?? null, steps: entry.steps?.total ?? null, usage: entry.stats?.usage ?? null
        });
        this.release(entry);
        entry.finish?.();
        void this.startNext();
      });
    } catch (error) {
      if (ownsLock) await rmdir(lock).catch(() => {});
      if (worktree && !entry.child) {
        const removal = await removeWorktree(worktree);
        if (!removal.removed) console.error(`[bridge] Could not remove the worktree of a launch that never started: ${removal.reason}`);
      }
      throw error;
    }
  }

  /** The release for an attempt that a failover is about to replace; the final reading of its watcher is held to the same budget as the release. */
  private async releaseAttemptTree(pid: number | null, startedAtMs: number, watch: TreeWatch): Promise<TreeReport> {
    const observed = await Promise.race([
      Promise.resolve().then(() => watch.stop()),
      new Promise<ProcessInfo[]>(resolve => { const timer = setTimeout(() => resolve([]), REAP_BUDGET_MS); timer.unref?.(); })
    ]).catch(() => [] as ProcessInfo[]);
    return this.releaseOwnedTree(pid, startedAtMs, observed);
  }

  /**
   * Releases the process tree an agent CLI left behind after the owned process exited, using the descendants that
   * were recorded while it ran. Bounded by REAP_BUDGET_MS: a wedged process query must never keep a finished task
   * from publishing its status.
   */
  private async releaseOwnedTree(pid: number | null, startedAtMs: number, observed: ProcessInfo[]): Promise<TreeReport> {
    if (pid === null) return {checked: false, reason: 'No process id was recorded for this task', reaped: [], skipped: []};
    const failure = (error: unknown): TreeReport =>
      ({checked: false, reason: error instanceof Error ? redact(error.message) : 'Process tree release failed', reaped: [], skipped: []});
    const run = Promise.resolve().then(() => (this.runtime.reapTree ?? reapOwnedTree)(pid, {started_at_ms: startedAtMs, observed})).catch(failure);
    const budget = new Promise<TreeReport>(resolve => {
      const timer = setTimeout(() => resolve({checked: false, reason: `Process tree release did not finish within ${REAP_BUDGET_MS}ms`, reaped: [], skipped: []}), REAP_BUDGET_MS);
      timer.unref?.();
    });
    const report = await Promise.race([run, budget]);
    if (report.reaped.length || report.skipped.length || report.reason) {
      console.error(`[bridge] Task tree release: ${report.reaped.length} process tree(s) reaped, ${report.skipped.length} left running${report.reason ? `; ${report.reason}` : ''}`);
    }
    return report;
  }

  /** Hands free lanes to the oldest waiting tasks that fit. A task that cannot start is failed here rather than thrown at a caller that has gone. */
  private async startNext(): Promise<void> {
    while (!this.closing && this.queue.length) {
      const entry = this.entries.get(this.queue[0]);
      if (!entry || entry.task.status !== 'queued') { this.queue.shift(); continue; }
      if (!this.canStart(entry.task.isolation)) break;
      const delegation = delegationState(this.runtime.stateDirectory);
      if (!delegation.enabled) {
        this.queue.shift();
        await this.endWithoutRunning(entry, 'canceled', `Canceled before it started: delegation was switched off (${delegation.reason}). No files were touched`);
        continue;
      }
      this.queue.shift();
      this.occupy(entry);
      try { await this.launch(entry); }
      catch (error) {
        this.release(entry);
        await this.endWithoutRunning(entry, this.closing || entry.stop === 'canceled' ? 'canceled' : 'failed', error instanceof Error ? redact(error.message) : 'Could not start the queued task');
      }
    }
  }
  private async endWithoutRunning(entry: Entry, status: Status, error: string) {
    entry.task.status = status; entry.task.ended_at = new Date().toISOString(); entry.task.error = error;
    entry.pending = undefined;
    await this.persist(entry.task);
    entry.finish?.();
  }

  /**
   * The owner's decisions about a finished worktree task (never an MCP client's): bring its changes into the workspace, or throw the
   * worktree away. One at a time, so two clicks cannot interleave two git operations on the same repository.
   */
  private decisionQueue: Promise<unknown> = Promise.resolve();
  private enqueueDecision<T>(work: () => Promise<T>): Promise<T> {
    const run = this.decisionQueue.then(work);
    this.decisionQueue = run.catch(() => undefined);
    return run;
  }
  private async reviewableTask(id: string, allowRunning = false): Promise<Task> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    const task = entry.task;
    if (task.isolation !== 'worktree' || !task.worktree) throw new Error('This task did not run in a worktree');
    if (!allowRunning && (task.status === 'queued' || task.status === 'running')) throw new Error('The task is still running');
    if (task.discarded_at) throw new Error('This task worktree was already discarded');
    const [root, canonical] = await Promise.all([
      realpath(path.join(this.runtime.stateDirectory, 'worktrees')).catch(() => null),
      realpath(task.worktree).catch(() => null)
    ]);
    if (!canonical) throw new Error('The task worktree no longer exists');
    if (!root || !inside(root, canonical)) throw new Error('The task worktree is not under the bridge state directory');
    return task;
  }
  private recordDecision(id: string, action: 'apply' | 'discard', ok: boolean, detail: string): Promise<void> {
    return appendDecision(this.runtime.stateDirectory, {at: new Date().toISOString(), task_id: id, action, ok, detail});
  }
  /** One file's content diff from a worktree task. Read only, so it is allowed while the task still runs. */
  async fileDiff(id: string, file: string): Promise<FileDiff> {
    const task = await this.reviewableTask(id, true);
    return worktreeFileDiff(task.worktree!, file);
  }
  applyTask(id: string): Promise<{task: TaskSummary; files: string[]}> {
    return this.enqueueDecision(async () => {
      const task = await this.reviewableTask(id);
      const refuse = async (reason: string): Promise<never> => { await this.recordDecision(id, 'apply', false, reason); throw new Error(reason); };
      if (task.status !== 'completed') return refuse(`Only a completed task can be applied (this one is ${task.status})`);
      if (task.applied_at) throw new Error('This task was already applied');
      if (task.scope?.out_of_scope.length) return refuse(`The task changed files outside its owned paths (${task.scope.out_of_scope.slice(0, 5).join(', ')}); review them in the worktree`);
      let workspace: string;
      try { workspace = await validateWorkspace(task.workspace, this.config.allowed_workspaces); }
      catch (error) { return refuse(`The workspace is no longer allowed: ${error instanceof Error ? error.message : 'invalid'}`); }
      let toplevel: string;
      try { toplevel = await repositoryRoot(workspace); }
      catch (error) { return refuse(error instanceof Error ? error.message : 'The workspace is not a git repository'); }
      const result = await applyWorktreeChanges({worktree: task.worktree!, toplevel, workspace, owns: task.owns});
      if (!result.applied) return refuse(result.reason);
      task.applied_at = new Date().toISOString();
      task.applied_files = result.files.slice(0, 100);
      await this.persist(task);
      await this.recordDecision(id, 'apply', true, `${result.files.length} file(s): ${result.files.slice(0, 5).join(', ')}`);
      return {task: this.summary(id), files: result.files};
    });
  }
  discardTask(id: string): Promise<TaskSummary> {
    return this.enqueueDecision(async () => {
      const task = await this.reviewableTask(id);
      let toplevel: string;
      try { toplevel = await repositoryRoot(await validateWorkspace(task.workspace, this.config.allowed_workspaces)); }
      catch (error) { const reason = error instanceof Error ? error.message : 'The workspace is not usable'; await this.recordDecision(id, 'discard', false, reason); throw new Error(reason); }
      const worktree: Worktree = {root: task.worktree!, workspace: task.worktree!, toplevel, branch: task.branch ?? '', prefix: '', base: ''};
      const removal = await removeWorktree(worktree);
      if (!removal.removed) {
        const reason = removal.reason ?? 'The worktree could not be removed';
        await this.recordDecision(id, 'discard', false, reason);
        throw new Error(reason);
      }
      task.discarded_at = new Date().toISOString();
      await this.persist(task);
      await this.recordDecision(id, 'discard', true, task.applied_at ? 'worktree removed after its changes were applied' : 'worktree removed without applying its changes');
      return this.summary(id);
    });
  }

  get(id: string): Task {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    const copy = structuredClone(entry.task);
    if (copy.process_running) copy.duration_ms = Date.now() - Date.parse(copy.started_at);
    return copy;
  }
  /** Status view: metadata only. Logs and the final response come from get(). */
  summary(id: string): TaskSummary {
    const {stdout: _stdout, stderr: _stderr, final_response: _response, attempts: _attempts, ...rest} = this.get(id);
    return rest;
  }
  /** All retained tasks, newest first, without logs. */
  list(): (TaskSummary & {title: string | null; tokens: number | null})[] {
    return [...this.entries.entries()]
      .map(([id, entry]) => ({...this.summary(id), title: entry.request?.task.split('\n').find(line => line.trim())?.trim().slice(0, 140) ?? null, tokens: totalTokens(entry.stats?.usage)}))
      .sort((a, b) => Date.parse(b.queued_at ?? b.started_at) - Date.parse(a.queued_at ?? a.started_at));
  }
  /** Models offered by the installed Antigravity CLI (read on demand, never at startup). */
  availableModels(): Promise<ModelInfo[]> {
    return this.runtime.models ? this.runtime.models() : listModels(this.runtime.executable, helperDirectory(), this.config.extra_env_passthrough, this.runtime.prefixArgs ?? []);
  }
  currentModel(): Promise<string | null> { return readModel(this.runtime.stateDirectory); }

  /** Full record for the web UI: the request, the exact prompt shape sent to the CLI (redacted), and the task with logs. */
  detail(id: string) {
    const task = this.get(id);
    const request = this.entries.get(id)?.request ?? null;
    const prompt = request ? promptFor({
      task: request.task, workspace: request.worktree ?? task.workspace, acceptance_criteria: request.acceptance_criteria,
      ...(request.context === null ? {} : {context: request.context}), timeout_seconds: request.timeout_seconds,
      ...(request.agent === undefined ? {} : {agent: request.agent}),
      isolation: request.isolation ?? 'none', owns: request.owns ?? [],
      ...(request.autonomy === undefined ? {} : {autonomy: request.autonomy})
    },request.client) : null;
    const entry = this.entries.get(id);
    return {task, request, prompt, activity: entry ? this.activityOf(entry) : null, stats: entry?.stats ?? null};
  }
  /** The latest sign of life: output on stdout/stderr or a write to agy's log file (the file's modification time). 0 when there has been none. */
  private lastActivity(entry: Entry): number {
    let log = 0;
    if (entry.logFile) { try { log = statSync(entry.logFile).mtimeMs; } catch { /* not created yet */ } }
    return Math.max(entry.lastOutputAt ?? 0, log);
  }
  /** What the web UI shows for a running task: the signs of life agy has given and the state of the soft deadline. */
  private activityOf(entry: Entry) {
    let logBytes: number | null = null; let logAt: number | null = null;
    if (entry.logFile) { try { const stats = statSync(entry.logFile); logBytes = stats.size; logAt = stats.mtimeMs; } catch { /* not created yet */ } }
    const last = this.lastActivity(entry);
    const iso = (value: number | null | undefined) => value ? new Date(value).toISOString() : null;
    return {
      last_output_at: iso(entry.lastOutputAt), log_updated_at: iso(logAt), log_bytes: logBytes, last_activity_at: iso(last || null),
      soft_deadline: entry.soft ? {extensions: entry.soft.extensions, next_check_at: iso(entry.soft.nextCheckAt), hard_limit_at: iso(entry.soft.hardLimitAt)} : null,
      steps: entry.steps ? {total: entry.steps.total, recent: entry.steps.recent.map(step => ({n: step.n, at: iso(step.at), summary: step.summary, raw: step.raw}))} : null
    };
  }
  /** One short line for the client about whether Antigravity is alive (only while the task runs): the MCP tools carry it so the client need not read logs. */
  activityNote(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry || entry.task.status !== 'running') return null;
    const last = this.lastActivity(entry);
    const source = entry.logFile && last && last !== (entry.lastOutputAt ?? 0) ? 'log' : 'output';
    const extended = (entry.soft?.extensions ? `; deadline extended ${entry.soft.extensions}x while active` : '')
      + (entry.steps ? `; ${entry.steps.total} steps reported` : '');
    return (last ? `last ${source} activity ${Math.max(0, Math.round((Date.now() - last) / 1000))}s ago` : 'no output or log activity seen yet (normal in print mode: agy prints when it finishes)') + extended;
  }
  /** Length of the next wait for a client that did not choose one: it grows with each call for this task (1 min, 5 min, the owner's maximum). */
  nextWaitSeconds(id: string, requested?: number): number {
    const cap = this.maxWaitSeconds;
    if (requested !== undefined) return Math.min(requested, cap);
    const entry = this.entries.get(id);
    if (!entry) return cap;
    const count = entry.bareWaits ?? 0;
    entry.bareWaits = count + 1;
    return rampedWaitSeconds(count, cap);
  }
  /** Longest single wait a client may ask for. */
  get maxWaitSeconds(): number { return readWait(this.runtime.stateDirectory) ?? this.config.max_wait_seconds ?? DEFAULT_MAX_WAIT_SECONDS; }
  /** Bounded long-poll: returns as soon as the task ends, or after `seconds` if it is still running. */
  async waitFor(id: string, seconds: number): Promise<Task> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([entry.done, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
    return this.get(id);
  }
  /** How often a waiting client that asked for progress hears from the bridge. */
  get progressIntervalMs(): number { return this.runtime.progressIntervalMs ?? 10000; }
  async wait(id: string): Promise<Task> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    await entry.done;
    return this.get(id);
  }
  async cancel(id: string): Promise<Task> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    if (entry.task.status === 'queued' || (entry.pending && !entry.child)) {
      entry.stop = 'canceled';
      this.queue = this.queue.filter(queuedId => queuedId !== id);
      await this.endWithoutRunning(entry, 'canceled', 'Canceled before it started; no files were touched');
      return this.get(id);
    }
    if (entry.child && entry.task.process_running) {
      entry.stop ??= 'canceled';
      await terminateOwned(entry.child);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([entry.done, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Process pipes did not close after cancellation; execution lock retained')), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.get(id);
  }
  async shutdown(): Promise<void> {
    this.stopAccepting();
    await Promise.all([...this.entries.keys()].map(id => this.cancel(id)));
    const pending = [...this.pendingRelease];
    if (!pending.length) return;
    // Bounded by the same budget the release answers with, plus the record write: a wedged process query must turn
    // into a lost report, never into a shutdown that hangs.
    await Promise.race([
      Promise.all(pending),
      new Promise<void>(resolve => { const timer = setTimeout(resolve, REAP_BUDGET_MS + 2000); timer.unref?.(); })
    ]);
  }
  stopAccepting(): void { this.closing = true; }

  get stateDirectory() { return this.runtime.stateDirectory; }
  private get tasksDirectory() { return path.join(this.runtime.stateDirectory, 'tasks'); }
  // Best effort: a failed write must never fail or hide a task.
  // `held` carries the request and stats for a write that happens after the entry was released, so patching the
  // record afterwards cannot blank them.
  private async persist(task: Task, held?: {request: TaskRequest | null; stats: TaskStats | null}) {
    if (!this.runtime.supported) return;
    const file = path.join(this.tasksDirectory, `${task.task_id}.json`);
    try {
      await mkdir(this.tasksDirectory, {recursive: true, mode: 0o700});
      const entry = this.entries.get(task.task_id);
      const request = held ? held.request : entry?.request ?? null;
      const stats = held ? held.stats : entry?.stats ?? null;
      await writeFile(`${file}.tmp`, JSON.stringify({task, request, stats}), {mode: 0o600});
      // Windows refuses to rename onto a record that another process holds open for reading, and both the web UI and
      // a polling client do that. Retry the swap instead of dropping the update.
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 2 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      await unlink(`${file}.tmp`).catch(() => {}); // history is a convenience, not a correctness requirement
    }
  }
  private async forget(id: string) {
    if (this.runtime.supported) await unlink(path.join(this.tasksDirectory, `${id}.json`)).catch(() => {});
  }
  /** Reload finished-task history after a restart. Tasks that were running are marked failed: their process did not survive. */
  async restore(): Promise<number> {
    let names: string[];
    try { names = (await readdir(this.tasksDirectory)).filter(name => TASK_FILE.test(name)); } catch { return 0; }
    const loaded: Task[] = [];
    const requests = new Map<string, TaskRequest>();
    const statsById = new Map<string, TaskStats>();
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(path.join(this.tasksDirectory, name), 'utf8')) as {task?: Task; request?: TaskRequest | null; stats?: TaskStats | null} & Task;
        // Records written before requests were kept hold the bare task.
        const task: Task = parsed.task ?? parsed;
        task.agent ??= 'antigravity';
        task.isolation ??= 'none';
        task.worktree ??= null;
        task.branch ??= null;
        task.owns ??= [];
        task.autonomy ??= 'auto';
        task.scope ??= null;
        const request = parsed.task ? parsed.request ?? undefined : undefined;
        if (`${task.task_id}.json` !== name || typeof task.started_at !== 'string') continue;
        if (request) requests.set(task.task_id, request);
        if (parsed.task && parsed.stats) statsById.set(task.task_id, parsed.stats);
        if (task.status === 'running' || task.status === 'queued') {
          const wasQueued = task.status === 'queued';
          task.status = 'failed'; task.process_running = false; task.ended_at ??= new Date().toISOString();
          task.error = wasQueued ? 'Bridge restarted while this task was queued; it never started and no files were touched'
            : 'Bridge restarted while this task was running; its process was not recovered. Inspect the workspace for partial changes';
          this.entries.set(task.task_id, {task, request, done: Promise.resolve()});
          await this.persist(task);
          this.entries.delete(task.task_id);
        }
        loaded.push(task);
      } catch { /* skip unreadable or foreign files */ }
    }
    loaded.sort((a, b) => Date.parse(b.queued_at ?? b.started_at) - Date.parse(a.queued_at ?? a.started_at));
    const keep = loaded.slice(0, this.config.max_retained_tasks).reverse();
    for (const task of loaded.slice(this.config.max_retained_tasks)) await this.forget(task.task_id);
    for (const task of keep) this.entries.set(task.task_id, {task, request: requests.get(task.task_id), stats: statsById.get(task.task_id), done: Promise.resolve()});
    return keep.length;
  }
  // Diagnose only; never remove a lock automatically, never kill anything. PIDs can be reused, so wording stays cautious.
  private async describeLock(lock: string): Promise<string> {
    const base = 'Execution lock exists. Another bridge may be running; inspect before removing a stale lock';
    let owner: {server_pid?: number; child_pid?: number | null; task_id?: string; started_at?: string};
    try { owner = JSON.parse(await readFile(path.join(this.runtime.stateDirectory, 'owner.json'), 'utf8')); } catch { return base; }
    const serverPid = Number(owner.server_pid);
    if (!Number.isInteger(serverPid) || serverPid <= 0) return base;
    if (pidAlive(serverPid)) return `${base} (owner server pid ${serverPid} is running)`;
    const childPid = Number(owner.child_pid);
    const child = Number.isInteger(childPid) && childPid > 0
      ? (pidAlive(childPid) ? ` A process with the recorded agy pid ${childPid} is still running (task ${owner.task_id ?? 'unknown'}); it may be an orphan of the crashed server (or an unrelated process that reused the pid) and may still be editing the workspace.`
        : ` The recorded agy pid ${childPid} is no longer running.`)
      : '';
    return `${base}. The recorded owner server pid ${serverPid} (started ${owner.started_at ?? 'unknown'}) is not running, so the lock may be stale.${child} Confirm no agy process is still running, then remove the directory ${lock} manually`;
  }
  /** Null when there is nothing to report; otherwise why an execution lock left by another bridge needs the owner's attention. */
  async lockDiagnostic(): Promise<string | null> {
    const lock = path.join(this.runtime.stateDirectory, 'execution.lock');
    if (!existsSync(lock)) return null;
    if (this.busy) return null;
    return this.describeLock(lock);
  }
  overview() {
    return {accepting_tasks: !this.closing, queue: {queued: this.queue.length, max: this.config.max_queued_tasks},
      concurrency: {normal_running: this.busy ? 1 : 0, worktrees_running: this.worktreeRunning, max_parallel_worktrees: this.maxParallelWorktrees},
      ...this.agentsOverview(),
      delegation: delegationState(this.runtime.stateDirectory), agy_permissions: permissionState(this.runtime.stateDirectory).level, max_wait_seconds: this.maxWaitSeconds, recent_tasks: [...this.entries.values()].map(({task}) => ({
      task_id: task.task_id, status: task.status, started_at: task.started_at, ended_at: task.ended_at
    }))};
  }
}
