import type { ChildProcess } from 'node:child_process';
import type { PromptTransport } from '../antigravity/invocation.js';
import type { ProcessOptions } from '../antigravity/process.js';
import type { TaskStats } from '../usage.js';

export type Autonomy = 'suggest' | 'auto' | 'full';
export type Isolation = 'none' | 'worktree';
export type AgentCapability = 'code' | 'review' | 'test' | 'research' | 'long-run';

export interface DeniedAction { action: string; display_name: string; }

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
}

export interface Invocation {
  executable: string;
  args: string[];
  stdin?: string;
  /** A file the CLI writes its final message to; read after the process closes. */
  resultFile?: string;
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
}

export interface AgentAdapter {
  id: string;
  label: string;
  capabilities: AgentCapability[];
  buildInvocation(task: AgentTask): Invocation;
  parseResult(raw: RawRun): Promise<AgentResult>;
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
