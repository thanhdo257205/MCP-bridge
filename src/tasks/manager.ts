import type { ChildProcess } from 'node:child_process';
import { mkdir, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { delegateSchema, promptFor, type DelegateInput } from '../security/input.js';
import { validateWorkspace } from '../security/workspace.js';
import { redact } from '../security/redact.js';
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
        catch { throw new Error('Execution lock exists. Another bridge may be running; inspect before removing a stale lock'); }
        await writeFile(path.join(this.runtime.stateDirectory, 'owner.json'), JSON.stringify({server_pid: process.pid, started_at: new Date().toISOString()}));
      }
      while (this.entries.size >= this.config.max_retained_tasks) {
        const oldest = [...this.entries].find(([, value]) => !value.task.process_running);
        if (!oldest) throw new Error('Task retention capacity reached');
        this.entries.delete(oldest[0]);
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
          this.busy = false;
          resolve();
        });
      });
      return this.get(task.task_id);
    } catch (error) {
      if (createdTaskId) this.entries.delete(createdTaskId);
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
  overview() {
    return {accepting_tasks: !this.closing, recent_tasks: [...this.entries.values()].map(({task}) => ({
      task_id: task.task_id, status: task.status, started_at: task.started_at, ended_at: task.ended_at
    }))};
  }
}
