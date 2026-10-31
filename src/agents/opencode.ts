import { startProcess, terminateOwned, type ResolvedCommand } from '../antigravity/process.js';
import type { AgentAdapter, AgentCapability, AgentResult, AgentRuntime, AgentStatus, AgentTask, Invocation, RawRun } from './types.js';
import { isQuotaError } from './quota.js';

export const CAPABILITIES: AgentCapability[] = ['code', 'review', 'test', 'research', 'long-run'];
// Verified against opencode v2.2.5: `opencode run` reads the message from stdin and, with `--format json`, writes one JSON event per line.
const REQUIRED_FLAGS = ['--format', '--model', '--auto', '--standalone'];
const MAX_RESPONSE_CHARS = 1024 * 1024;

export interface OpenCodeOptions {
  id?: string;
  label?: string;
  /** `provider/model`, as printed by `opencode models`. */
  model?: string;
  env?: Record<string, string>;
  /** Always pass `--auto` (approve permissions the OpenCode config does not explicitly deny), whatever the task's autonomy. */
  autoApprove?: boolean;
}

export function opencodeAdapter(command: ResolvedCommand, options: OpenCodeOptions = {}): AgentAdapter {
  return {
    id: options.id ?? 'opencode',
    label: options.label ?? 'OpenCode',
    family: 'opencode',
    capabilities: CAPABILITIES,
    buildInvocation(task: AgentTask): Invocation {
      // `run` is the subcommand, so its flags follow it. The message goes over stdin: argv is capped (about 32 KB on Windows),
      // a prompt starting with "-" would be read as a flag, and splitting it into words would lose its line breaks.
      // The working directory is the process cwd, set by the launcher.
      // `--standalone` gives the run a private server. Without it `opencode run` hands the task to the shared OpenCode
      // background service (the one the desktop app keeps running): measured on v2.2.5, cancelling the client then left the
      // agent working, its shell was a child of the service and not of the run the bridge can reap, and the session showed up
      // in the owner's OpenCode. With it, killing the run stopped the work and left no process behind.
      const args = ['run', '--standalone', '--format', 'json'];
      const model = task.model ?? options.model;
      if (model) args.push('--model', model);
      // Without --auto opencode still edits files and runs shell commands in the workspace without asking (measured on v2.2.5);
      // --auto also approves what its config would otherwise ask about, such as paths outside the workspace.
      // Only the owner can turn it on (agents.opencode_auto_approve): the task's `autonomy` is chosen by the delegating client and is an
      // instruction to the agent, never a permission grant, so it must not reach a flag that takes approval away.
      if (options.autoApprove) args.push('--auto');
      return {
        executable: command.executable,
        args: [...command.prefixArgs, ...args],
        stdin: `${task.prompt}\n`,
        customEnv: options.env
      };
    },
    compactLine(line: string): string | null {
      let event: unknown;
      try { event = JSON.parse(line); } catch { return line; /* not an event: kept, it may be the only clue to a failure */ }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return line;
      const {type, part} = event as {type?: unknown; part?: {tool?: unknown; state?: {status?: unknown}}};
      // parseResult reads text, error and step_finish events, so those stay whole.
      if (type === 'text' || type === 'error' || type === 'step_finish') return line;
      if (type === 'step_start') return null;
      // A tool event carries the file or command output it produced: keep which tool ran and how it ended, not the payload.
      if (type === 'tool_use') return JSON.stringify({type, part: {tool: part?.tool, state: {status: part?.state?.status}}});
      return line.length > 2000 ? JSON.stringify({type}) : line;
    },
    async parseResult(raw: RawRun): Promise<AgentResult> {
      const texts: string[] = [];
      const errors: string[] = [];
      let turns = 0;
      let finishReason: string | null = null;
      let inputTokens = 0; let outputTokens = 0; let sawTokens = false;
      for (const line of raw.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          const value = JSON.parse(line) as unknown;
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          event = value as Record<string, unknown>;
        } catch { continue; /* A non-JSON line stays in the raw log but cannot change the result. */ }
        const part = event.part as Record<string, unknown> | undefined;
        if (event.type === 'text' && typeof part?.text === 'string') texts.push(part.text);
        else if (event.type === 'error') {
          const error = event.error as Record<string, unknown> | undefined;
          errors.push(typeof error?.message === 'string' ? error.message : typeof error?.type === 'string' ? error.type : 'OpenCode reported an error');
        } else if (event.type === 'step_finish') {
          turns++;
          if (typeof part?.reason === 'string') finishReason = part.reason;
          const tokens = part?.tokens as Record<string, unknown> | undefined;
          if (typeof tokens?.input === 'number') { inputTokens += tokens.input; sawTokens = true; }
          if (typeof tokens?.output === 'number') { outputTokens += tokens.output; sawTokens = true; }
        }
      }
      // The last text event is the final answer; earlier ones are narration between tool calls.
      const response = texts.at(-1)?.slice(0, MAX_RESPONSE_CHARS).trim() || null;
      const base: AgentResult = {
        success: false, response, error: null, cliStatus: finishReason, numTurns: turns || null, deniedActions: [],
        stats: sawTokens ? {usage: {input_tokens: inputTokens, output_tokens: outputTokens}, agy_duration_seconds: null, num_turns: turns || null, steps: turns || null} : undefined
      };
      if (raw.exitCode === 0 && !errors.length && response) return {...base, success: true, numTurns: turns || 1};
      if (raw.signal) return {...base, error: `OpenCode was terminated (${raw.signal})`};
      const stderrTail = raw.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500);
      const finalErr = errors.at(-1) ?? stderrTail ?? (raw.exitCode === 0 ? 'OpenCode did not provide a final message' : `OpenCode exited ${raw.exitCode}`);
      // Only a failed run can be out of quota: a successful answer that merely mentions "429" must not trigger a failover.
      const quotaHit = isQuotaError(finalErr) || isQuotaError(raw.stderr) || errors.some(isQuotaError);
      return {...base, error: finalErr, cliStatus: quotaHit ? 'quota_exceeded' : base.cliStatus ?? `exit ${raw.exitCode}`, isQuotaExceeded: quotaHit};
    }
  };
}

export function opencodeAgent(command: ResolvedCommand, status: AgentStatus, options: OpenCodeOptions = {}): AgentRuntime {
  return {adapter: opencodeAdapter(command, options), status, enabled: true, prefixArgs: command.prefixArgs};
}

interface Capture { code: number | null; text: string; }
function capture(command: ResolvedCommand, args: string[], cwd: string, extraEnvPassthrough: string[]): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = startProcess(command.executable, [...command.prefixArgs, ...args], cwd, {extraEnvPassthrough});
    let text = '';
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; void terminateOwned(child).catch(reject); }, 10000);
    const append = (chunk: Buffer) => { if (text.length < 32768) text += chunk.toString().slice(0, 32768 - text.length); };
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); exceeded ? reject(new Error('OpenCode inspection timed out')) : resolve({code, text}); });
  });
}

/** Non-interactive `opencode run --format json` is the only contract this adapter relies on. */
export async function detectOpenCode(command: ResolvedCommand, opts: {cwd?: string; extraEnvPassthrough?: string[]} = {}): Promise<AgentStatus> {
  const cwd = opts.cwd ?? process.cwd();
  const extra = opts.extraEnvPassthrough ?? [];
  const status = (available: boolean, version: string | null, warnings: string[]): AgentStatus => ({
    id: 'opencode', label: 'OpenCode', available, version, executable: command.executable, capabilities: CAPABILITIES, warnings
  });
  try {
    const version = await capture(command, ['--version'], cwd, extra);
    const help = await capture(command, ['run', '--help'], cwd, extra);
    const parsed = version.text.trim().split(/\r?\n/)[0]?.replace(/^opencode\s+/i, '').replace(/^v/i, '') || null;
    if (version.code !== 0) return status(false, null, ['opencode --version failed']);
    if (help.code !== 0) return status(false, parsed, ['opencode run --help failed']);
    const missing = REQUIRED_FLAGS.filter(flag => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,]|$)`).test(help.text));
    if (missing.length) return status(false, parsed, [`OpenCode CLI is missing required run flags: ${missing.join(', ')}`]);
    return status(true, parsed, []);
  } catch (error) {
    return status(false, null, [`OpenCode CLI could not be inspected: ${error instanceof Error ? error.message : 'unknown error'}`]);
  }
}
