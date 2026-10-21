import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { delegateSchema, promptFor, type DelegateInput } from '../security/input.js';
import { validateWorkspace } from '../security/workspace.js';
import { redact } from '../security/redact.js';
import { delegationState } from '../delegation.js';
import { startProcess, terminateOwned } from '../antigravity/process.js';
import {pidAlive, recoverExecutionLock} from './execution-lock.js';

export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'canceled' | 'unsupported';
export interface Task {
  task_id: string; workspace: string; status: Status; started_at: string; queued_at: string | null; ended_at: string | null;
  duration_ms: number; pid: number | null; process_running: boolean;
  exit_code: number | null; signal: string | null; stdout: string; stderr: string;
  stdout_bytes: number; stderr_bytes: number; stdout_truncated: boolean; stderr_truncated: boolean;
  final_response: string | null; cli_status: string | null; error: string | null;
  denied_actions: {action: string; display_name: string}[];
  review_required: true; acceptance_verified: false;
}
export type TaskSummary = Omit<Task, 'stdout' | 'stderr' | 'final_response'>;
const TASK_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
/** What the Tech Lead asked for. Kept beside the task (not in it) so MCP responses stay small; shown in the web UI. */
export interface TaskRequest { task: string; acceptance_criteria: string[]; context: string | null; timeout_seconds: number; client?: string | null; }
interface Entry {
  task: Task; request?: TaskRequest; child?: ChildProcess; done: Promise<void>; stop?: Status;
  /** Resolves `done`; set for every task that goes through the CLI. */
  finish?: () => void;
  /** Validated input kept until the process starts (a queued task waits with it). */
  pending?: {input: DelegateInput; workspace: string; timeout: number};
}
export interface Runtime {
  executable: string; supported: boolean; stateDirectory: string;
  launch?: (args: string[], cwd: string) => ChildProcess;
}

export class TaskManager {
  private entries = new Map<string, Entry>();
  private busy = false;
  private queue: string[] = [];
  private admission: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(private config: Config, private runtime: Runtime) {}

  /** Calls are admitted strictly in the order they arrive: workspace validation is asynchronous and must not let a later call overtake an earlier one. */
  delegate(raw: DelegateInput, meta: {client?: string | null} = {}): Promise<Task> {
    const admitted = this.admission.then(() => this.admit(raw, meta));
    this.admission = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  private async admit(raw: DelegateInput, meta: {client?: string | null}): Promise<Task> {
    if (this.closing) throw new Error('Bridge is shutting down');
    const delegation = delegationState(this.runtime.stateDirectory);
    if (!delegation.enabled) throw new Error(`Delegation to Antigravity is disabled by the bridge owner (${delegation.reason}). Do not delegate; do this work yourself or ask the user to run \`agy-mcp-bridge delegation on\` (\`npm run delegation -- on\` in a git checkout)`);
    const input = delegateSchema.parse(raw);
    const timeout = input.timeout_seconds ?? this.config.default_timeout_seconds;
    if (timeout > this.config.max_timeout_seconds) throw new Error('Timeout exceeds configured maximum');
    const workspace = await validateWorkspace(input.workspace, this.config.allowed_workspaces);
    if (this.closing) throw new Error('Bridge is shutting down');

    // Everything from here to the registration of the entry is synchronous, so concurrent callers cannot both claim the slot.
    // One task runs globally (also protects overlapping parent/child workspaces); the rest wait in a bounded queue.
    const queued = this.runtime.supported && this.busy;
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
      task_id: randomUUID(), workspace, status: !this.runtime.supported ? 'unsupported' : queued ? 'queued' : 'running',
      started_at: now, queued_at: queued ? now : null, ended_at: null, duration_ms: 0,
      pid: null, process_running: false, exit_code: null, signal: null,
      stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0,
      stdout_truncated: false, stderr_truncated: false,
      final_response: null, cli_status: null, error: null, denied_actions: [], review_required: true, acceptance_verified: false
    };
    const entry: Entry = {
      task, done: Promise.resolve(), pending: {input, workspace, timeout},
      request: {
        task: redact(input.task), acceptance_criteria: input.acceptance_criteria.map(redact),
        context: input.context === undefined ? null : redact(input.context), timeout_seconds: timeout,
        client: meta.client ? redact(meta.client).slice(0, 100) : null
      }
    };
    this.entries.set(task.task_id, entry);
    if (this.runtime.supported) {
      entry.done = new Promise<void>(resolve => { entry.finish = resolve; });
      if (queued) this.queue.push(task.task_id); else this.busy = true;
    }
    await Promise.all(evicted.map(id => this.forget(id)));
    await this.persist(task);

    if (!this.runtime.supported) {
      task.ended_at = new Date().toISOString();
      task.error = 'Only locally verified agy 1.4.3 print/json execution is enabled';
      return this.get(task.task_id);
    }
    if (queued) return this.get(task.task_id);
    try { await this.launch(entry); }
    catch (error) {
      this.entries.delete(task.task_id);
      await this.forget(task.task_id);
      entry.finish?.();
      this.busy = false;
      throw error;
    }
    return this.get(task.task_id);
  }

  /** Starts the process for an entry that already owns the global slot (`busy`). Throws only before the process exists. */
  private async launch(entry: Entry): Promise<void> {
    const {task} = entry;
    const {input, workspace, timeout} = entry.pending!;
    let ownsLock = false;
    const lock = path.join(this.runtime.stateDirectory, 'execution.lock');
    try {
      if (this.closing) throw new Error('Bridge is shutting down');
      if (task.queued_at) {
        try { await validateWorkspace(workspace, this.config.allowed_workspaces); }
        catch (error) { throw new Error(`Queued workspace validation failed before execution: ${error instanceof Error ? error.message : 'invalid workspace'}`); }
      }
      await mkdir(this.runtime.stateDirectory, { recursive: true });
      try { await mkdir(lock); ownsLock = true; }
      catch {
        const recovery=await recoverExecutionLock(this.runtime.stateDirectory);
        if(!recovery.reclaimed)throw new Error(await this.describeLock(lock));
        await mkdir(lock);ownsLock=true;
      }
      const checkStarting = () => {
        if (this.closing || entry.stop === 'canceled' || task.status === 'canceled') throw new Error('Canceled before execution');
      };
      checkStarting();
      // Persist the transition before spawning: after a crash we must not claim queued work never ran.
      task.status = 'running';
      task.started_at = new Date().toISOString();
      await this.persist(task);
      checkStarting();
      const args = ['--print', promptFor({...input, workspace}), '--output-format', 'json', '--print-timeout', `${timeout}s`, '--disable-slash-commands'];
      const child = this.runtime.launch ? this.runtime.launch(args, workspace) : startProcess(this.runtime.executable, args, workspace);
      entry.child = child;
      entry.pending = undefined;
      task.status = 'running';
      task.started_at = new Date().toISOString();
      task.pid = child.pid ?? null;
      task.process_running = Boolean(child.pid);
      const started = Date.now();
      const buffers = {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
      let finalized = false;
      const requestStop = (reason: Status) => {
        if (!entry.stop) entry.stop = reason;
        void terminateOwned(child).catch(() => { task.error = 'Failed to terminate owned process tree; execution lock is retained until process closes'; });
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        task[`${stream}_bytes`] += chunk.length;
        const available = this.config.max_output_bytes - buffers[stream].length;
        if (available > 0) buffers[stream] = Buffer.concat([buffers[stream], chunk.subarray(0, available)]);
        if (chunk.length > available) {
          task[`${stream}_truncated`] = true;
          task.error = 'Output limit exceeded; incomplete output cannot establish success';
          requestStop('failed');
        }
        task[stream] = redact(buffers[stream].toString('utf8'));
      };
      child.stdout!.on('data', (data: Buffer) => capture('stdout', data));
      child.stderr!.on('data', (data: Buffer) => capture('stderr', data));
      const timer = setTimeout(() => requestStop('timeout'), (timeout + 10) * 1000);
      child.once('error', () => { task.error = 'Could not start Antigravity process'; });
      // Not awaited: no await may sit between spawn and the listeners above, or an early 'error' event would go unhandled.
      void writeFile(path.join(this.runtime.stateDirectory, 'owner.json'), JSON.stringify({server_pid: process.pid, child_pid: child.pid ?? null, task_id: task.task_id, started_at: task.started_at})).catch(() => {});
      child.once('close', async (code, signal) => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timer);
        // A POSIX child can exit while its group is still being given its graceful shutdown window.
        if (entry.stop) await terminateOwned(child).catch(() => { task.error = 'Owned process group cleanup failed'; });
        task.exit_code = code; task.signal = signal; task.process_running = false;
        task.ended_at = new Date().toISOString(); task.duration_ms = Date.now() - started;
        task.status = entry.stop ?? 'failed';
        if (!entry.stop) {
          try {
            const result = JSON.parse(buffers.stdout.toString('utf8'));
            task.cli_status = typeof result.status === 'string' ? result.status : null;
            task.final_response = typeof result.response === 'string' ? redact(result.response) : null;
            if (Array.isArray(result.denied_actions)) task.denied_actions = result.denied_actions.slice(0,100).map((item: unknown) => {
              const value = item as Record<string, unknown> | null;
              return {action: redact(String(value?.action ?? 'unknown')).slice(0,200), display_name: redact(String(value?.display_name ?? '')).slice(0,200)};
            });
            if (/print timeout|AGY_ERROR.*TIMEOUT/i.test(buffers.stderr.toString('utf8'))) {
              task.status = 'timeout'; task.error = 'CLI reported a print timeout (possibly with exit code 0)';
            } else if (task.denied_actions.length || /auto-denied|soft.denied|permission.*cannot prompt/i.test(buffers.stderr.toString('utf8'))) {
              task.error = 'Required tool permissions were denied; approve a scoped rule interactively before retrying';
            } else if (code === 0 && result.status === 'SUCCESS' && typeof result.num_turns === 'number' && result.num_turns > 0 && task.final_response?.trim()) {
              task.status = 'completed';
            } else {
              task.error = typeof result.error === 'string' ? redact(result.error) : 'CLI did not provide a complete successful response';
            }
          } catch { task.error ??= 'CLI output is not a valid final JSON envelope'; }
        }
        if (task.status === 'timeout') task.error ??= 'Task exceeded its execution deadline';
        if (task.status === 'canceled') task.error ??= 'Task canceled; partial file changes may remain';
        if (ownsLock) {
          try { await rmdir(lock); } catch { task.error ??= 'Could not release execution lock'; }
        }
        await this.persist(task);
        this.busy = false;
        entry.finish?.();
        void this.startNext();
      });
    } catch (error) {
      if (ownsLock) await rmdir(lock).catch(() => {});
      throw error;
    }
  }

  /** Hands the global slot to the oldest waiting task. A task that cannot start is failed here rather than thrown at a caller that has gone. */
  private async startNext(): Promise<void> {
    while (!this.busy && !this.closing && this.queue.length) {
      const entry = this.entries.get(this.queue.shift()!);
      if (!entry || entry.task.status !== 'queued') continue;
      const delegation = delegationState(this.runtime.stateDirectory);
      if (!delegation.enabled) {
        await this.endWithoutRunning(entry, 'canceled', `Canceled before it started: delegation was switched off (${delegation.reason}). No files were touched`);
        continue;
      }
      this.busy = true;
      try { await this.launch(entry); }
      catch (error) {
        this.busy = false;
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

  get(id: string): Task {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    const copy = structuredClone(entry.task);
    if (copy.process_running) copy.duration_ms = Date.now() - Date.parse(copy.started_at);
    return copy;
  }
  /** Status view: metadata only. Logs and the final response come from get(). */
  summary(id: string): TaskSummary {
    const {stdout: _stdout, stderr: _stderr, final_response: _response, ...rest} = this.get(id);
    return rest;
  }
  /** All retained tasks, newest first, without logs. */
  list(): (TaskSummary & {title: string | null})[] {
    return [...this.entries.entries()]
      .map(([id, entry]) => ({...this.summary(id), title: entry.request?.task.split('\n').find(line => line.trim())?.trim().slice(0, 140) ?? null}))
      .sort((a, b) => Date.parse(b.queued_at ?? b.started_at) - Date.parse(a.queued_at ?? a.started_at));
  }
  /** Full record for the web UI: the request, the exact prompt shape sent to the CLI (redacted), and the task with logs. */
  detail(id: string) {
    const task = this.get(id);
    const request = this.entries.get(id)?.request ?? null;
    const prompt = request ? promptFor({
      task: request.task, workspace: task.workspace, acceptance_criteria: request.acceptance_criteria,
      ...(request.context === null ? {} : {context: request.context}), timeout_seconds: request.timeout_seconds
    }) : null;
    return {task, request, prompt};
  }
  /** Bounded long-poll: returns as soon as the task ends, or after `seconds` if it is still running. */
  async waitFor(id: string, seconds: number): Promise<Task> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown or expired task_id');
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([entry.done, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
    return this.get(id);
  }
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
  }
  stopAccepting(): void { this.closing = true; }

  get stateDirectory() { return this.runtime.stateDirectory; }
  private get tasksDirectory() { return path.join(this.runtime.stateDirectory, 'tasks'); }
  // Best effort: a failed write must never fail or hide a task.
  private async persist(task: Task) {
    if (!this.runtime.supported) return;
    try {
      await mkdir(this.tasksDirectory, {recursive: true, mode: 0o700});
      const file = path.join(this.tasksDirectory, `${task.task_id}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify({task, request: this.entries.get(task.task_id)?.request ?? null}), {mode: 0o600});
      await rename(`${file}.tmp`, file);
    } catch { /* history is a convenience, not a correctness requirement */ }
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
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(path.join(this.tasksDirectory, name), 'utf8')) as {task?: Task; request?: TaskRequest | null} & Task;
        // Records written before requests were kept hold the bare task.
        const task: Task = parsed.task ?? parsed;
        const request = parsed.task ? parsed.request ?? undefined : undefined;
        if (`${task.task_id}.json` !== name || typeof task.started_at !== 'string') continue;
        if (request) requests.set(task.task_id, request);
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
    for (const task of keep) this.entries.set(task.task_id, {task, request: requests.get(task.task_id), done: Promise.resolve()});
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
    return {accepting_tasks: !this.closing, queue: {queued: this.queue.length, max: this.config.max_queued_tasks}, delegation: delegationState(this.runtime.stateDirectory), recent_tasks: [...this.entries.values()].map(({task}) => ({
      task_id: task.task_id, status: task.status, started_at: task.started_at, ended_at: task.ended_at
    }))};
  }
}
