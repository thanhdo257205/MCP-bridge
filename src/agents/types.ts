import type { ChildProcess } from 'node:child_process';
import type { PromptTransport } from '../antigravity/invocation.js';
import type { ProcessOptions } from '../antigravity/process.js';
import type { TaskStats } from '../usage.js';

export type Autonomy = 'suggest' | 'auto' | 'full';
export type Isolation = 'none' | 'worktree';
export type AgentCapability = 'code' | 'review' | 'test' | 'research' | 'long-run';
/** The CLI dialect a task is turned into. Owner settings key on this rather than on `id`, so a profile inherits them with its adapter. */
export type AgentFamily = 'antigravity' | 'codex' | 'opencode';

/**
 * `suspected` marks a denial the bridge only inferred from text (a failed command whose output says "access denied"), as opposed to one the CLI
 * itself reported. It is shown as a guess and never changes the status of the task.
 */
export interface DeniedAction { action: string; display_name: string; suspected?: boolean; }

/**
 * Extra permission the owner gave ONE run, chosen in the web UI after a task was denied something. It lives on the new task's record and in that
 * run's arguments or environment; it is never written to a setting, so the next task starts from the owner's own configuration again.
 * Each kind is the narrowest the CLI offers for its case (docs/APPROVAL-QUEUE-PLAN.md section 5.2).
 */
export type Elevation =
  | {kind: 'agy-level'; level: 'accept-edits' | 'auto' | 'full'}
  | {kind: 'codex-add-dir'; dir: string}
  | {kind: 'opencode-allow'; permission: 'bash' | 'edit'}
  | {kind: 'opencode-auto'};

export interface AgentStatus {
  id: string; label: string; available: boolean; version: string | null;
  executable: string | null; capabilities: AgentCapability[]; warnings: string[];
}

export interface AgentTask {
  prompt: string; workspace: string; timeoutSeconds: number; autonomy: Autonomy;
  owns: string[]; taskId: string; stateDirectory: string; model?: string | null;
  /** CLI-specific flags this adapter understands (Antigravity permissions, effort, log file). */
  extraArgs?: string[];
  /** Output mode for adapters that support more than one (Antigravity). */
  promptTransport?: PromptTransport;
  /** Extra permission for this one run, granted by the owner (see Elevation). Antigravity's is applied by the manager, through its permission level. */
  elevation?: Elevation;
}

export interface Invocation {
  executable: string;
  args: string[];
  stdin?: string;
  /** A file the CLI writes its final message to; read after the process closes. */
  resultFile?: string;
  customEnv?: Record<string, string>;
  /** How stdout should be parsed; set only by adapters that support several modes. */
  transport?: PromptTransport;

}

export interface RawRun {
  stdout: string; stderr: string; exitCode: number | null; signal: string | null;
  resultFile: string | null;
  transport?: PromptTransport;

}

export interface AgentResult {
  success: boolean;
  response: string | null;
  error: string | null;
  cliStatus: string | null;
  numTurns: number | null;
  deniedActions: DeniedAction[];
  /** Usage/duration reported by the CLI, when it reports any. */
  stats?: TaskStats;
  /** The CLI itself reported a timeout (exit code may still be 0). */
  timeout?: boolean;
  /** Indicates if the failure was caused by rate limit, token or billing quota exhaustion. */
  isQuotaExceeded?: boolean;
}

export interface AgentAdapter {
  id: string;
  label: string;
  family: AgentFamily;
  capabilities: AgentCapability[];
  buildInvocation(task: AgentTask): Invocation;
  parseResult(raw: RawRun): Promise<AgentResult>;
  /**
   * For a CLI whose stdout is a JSON event stream: the form of one complete stdout line that is kept in the task log, or null to
   * drop it. Tool events carry whole files and command output, which would fill the output cap long before the answer arrives
   * and cancel a task that is working; parseResult then reads only what is kept, so it must keep every event it relies on.
   */
  compactLine?(line: string): string | null;
}

export interface AgentRuntime {
  adapter: AgentAdapter;
  status: AgentStatus;
  enabled: boolean;
  /** Prepended to the adapter's args (for example the resolved .js entry of a Windows shim). */
  prefixArgs?: string[];
  /** Test/embedding hook: replace process spawning entirely. */
  launch?: (args: string[], cwd: string, options?: ProcessOptions) => ChildProcess;
}

/** The shape sent to clients; never includes local secrets. */
export type PublicAgentStatus = Omit<AgentStatus, 'executable'> & { executable: string | null; enabled: boolean };
