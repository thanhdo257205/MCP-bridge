import type { ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { delegateSchema, promptFor, type DelegateInput } from '../security/input.js';
import { validateWorkspace } from '../security/workspace.js';
import { redact } from '../security/redact.js';
import { delegationState } from '../delegation.js';
import { startProcess, terminateOwned } from '../antigravity/process.js';

export type Status = 'running' | 'completed' | 'failed' | 'timeout' | 'canceled' | 'unsupported';
export interface Task {
  task_id: string; workspace: string; status: Status; started_at: string; ended_at: string | null;
  duration_ms: number; pid: number | null; process_running: boolean;
  exit_code: number | null; signal: string | null; stdout: string; stderr: string;
  stdout_bytes: number; stderr_bytes: number; stdout_truncated: boolean; stderr_truncated: boolean;
  final_response: string | null; cli_status: string | null; error: string | null;
  denied_actions: {action: string; display_name: string}[];
  review_required: true; acceptance_verified: false;
}
export type TaskSummary = Omit<Task, 'stdout' | 'stderr' | 'final_response'>;
const TASK_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
interface Entry { task: Task; child?: ChildProcess; done: Promise<void>; stop?: Status; }
export interface Runtime {
  executable: string; supported: boolean; stateDirectory: string;
  launch?: (args: string[], cwd: string) => ChildProcess;
}

export class TaskManager {
  private entries = new Map<string, Entry>();
  private busy = false;
  private closing = false;
  constructor(private config: Config, private runtime: Runtime) {}

  async delegate(raw: DelegateInput): Promise<Task> {
    if (this.closing) throw new Error('Bridge is shutting down');
    const delegation = delegationState(this.runtime.stateDirectory);
    if (!delegation.enabled) throw new Error(`Delegation to Antigravity is disabled by the bridge owner (${delegation.reason}). Do not delegate; do this work yourself or ask the user to run \`npm run delegation -- on\``);
    const input = delegateSchema.parse(raw);
    const timeout = input.timeout_seconds ?? this.config.default_timeout_seconds;
    if (timeout > this.config.max_timeout_seconds) throw new Error('Timeout exceeds configured maximum');
    // One task globally: also protects overlapping parent/child workspaces.
    if (this.busy) throw new Error('Bridge is busy with another task');
    this.busy = true;
    let ownsLock = false;
    let createdTaskId: string | undefined;
    const lock = path.join(this.runtime.stateDirectory, 'execution.lock');
    try {
      const workspace = await validateWorkspace(input.workspace, this.config.allowed_workspaces);
      if (this.closing) throw new Error('Bridge is shutting down');
      if (this.runtime.supported) {
        await mkdir(this.runtime.stateDirectory, { recursive: true });
        try { await mkdir(lock); ownsLock = true; }
        catch { throw new Error(await this.describeLock(lock)); }
        await writeFile(path.join(this.runtime.stateDirectory, 'owner.json'), JSON.stringify({server_pid: process.pid, started_at: new Date().toISOString()}));
      }
      while (this.entries.size >= this.config.max_retained_tasks) {
        const oldest = [...this.entries].find(([, value]) => !value.task.process_running);
        if (!oldest) throw new Error('Task retention capacity reached');
        this.entries.delete(oldest[0]);
        await this.forget(oldest[0]);
      }
      const task: Task = {
        task_id: randomUUID(), workspace, status: this.runtime.supported ? 'running' : 'unsupported',
        started_at: new Date().toISOString(), ended_at: null, duration_ms: 0,
        pid: null, process_running: false, exit_code: null, signal: null,
        stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0,
        stdout_truncated: false, stderr_truncated: false,
        final_response: null, cli_status: null, error: null, denied_actions: [], review_required: true, acceptance_verified: false
      };
      const entry: Entry = { task, done: Promise.resolve() };
      this.entries.set(task.task_id, entry);
      createdTaskId = task.task_id;
      if (this.runtime.supported) await this.persist(task);
      if (!this.runtime.supported) {
        task.ended_at = new Date().toISOString();
        task.error = 'Only locally verified agy 1.4.3 print/json execution is enabled';
        this.busy = false;
        return this.get(task.task_id);
      }
      if (this.closing) throw new Error('Bridge is shutting down');
      const args = ['--print', promptFor({...input, workspace}), '--output-format', 'json', '--print-timeout', `${timeout}s`, '--disable-slash-commands'];
      const child = this.runtime.launch ? this.runtime.launch(args, workspace) : startProcess(this.runtime.executable, args, workspace);
      entry.child = child;
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
      const timer = setTimeout(() => requestStop('timeout'), timeout * 1000);
      entry.done = new Promise<void>(resolve => {
        child.once('error', () => { task.error = 'Could not start Antigravity process'; });
        child.once('close', async (code, signal) => {
          if (finalized) return;
          finalized = true;
          clearTimeout(timer);
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
          resolve();
        });
      });
      return this.get(task.task_id);
    } catch (error) {
      if (createdTaskId) { this.entries.delete(createdTaskId); await this.forget(createdTaskId); }
      if (ownsLock) await rmdir(lock).catch(() => {});
      this.busy = false;
      throw error;
    }
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

  private get tasksDirectory() { return path.join(this.runtime.stateDirectory, 'tasks'); }
  // Best effort: a failed write must never fail or hide a task.
  private async persist(task: Task) {
    if (!this.runtime.supported) return;
    try {
      await mkdir(this.tasksDirectory, {recursive: true, mode: 0o700});
      const file = path.join(this.tasksDirectory, `${task.task_id}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(task), {mode: 0o600});
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
    for (const name of names) {
      try {
        const task = JSON.parse(await readFile(path.join(this.tasksDirectory, name), 'utf8')) as Task;
        if (`${task.task_id}.json` !== name || typeof task.started_at !== 'string') continue;
        if (task.status === 'running') {
          task.status = 'failed'; task.process_running = false; task.ended_at ??= new Date().toISOString();
          task.error = 'Bridge restarted while this task was running; its process was not recovered. Inspect the workspace for partial changes';
          await this.persist(task);
        }
        loaded.push(task);
      } catch { /* skip unreadable or foreign files */ }
    }
    loaded.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    const keep = loaded.slice(0, this.config.max_retained_tasks).reverse();
    for (const task of loaded.slice(this.config.max_retained_tasks)) await this.forget(task.task_id);
    for (const task of keep) this.entries.set(task.task_id, {task, done: Promise.resolve()});
    return keep.length;
  }
  // Diagnose only; never remove a lock automatically.
  private async describeLock(lock: string): Promise<string> {
    const base = 'Execution lock exists. Another bridge may be running; inspect before removing a stale lock';
    try {
      const owner = JSON.parse(await readFile(path.join(this.runtime.stateDirectory, 'owner.json'), 'utf8')) as {server_pid?: number; started_at?: string};
      const pid = Number(owner.server_pid);
      if (!Number.isInteger(pid) || pid <= 0) return base;
      try { process.kill(pid, 0); return `${base} (owner server pid ${pid} is running)`; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return `${base} (owner server pid ${pid} is running)`;
        return `${base}. The recorded owner server pid ${pid} (started ${owner.started_at ?? 'unknown'}) is not running, so the lock may be stale. Confirm no agy process is still running, then remove the directory ${lock} manually`;
      }
    } catch { return base; }
  }
  overview() {
    return {accepting_tasks: !this.closing, delegation: delegationState(this.runtime.stateDirectory), recent_tasks: [...this.entries.values()].map(({task}) => ({
      task_id: task.task_id, status: task.status, started_at: task.started_at, ended_at: task.ended_at
    }))};
  }
}
