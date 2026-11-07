import type { ResolvedCommand } from '../antigravity/process.js';
import { flattenNumbers, type TaskStats } from '../usage.js';
import { captureOutput } from './probe.js';
import { isQuotaError, isStrongQuotaError } from './quota.js';
import type { AgentAdapter, AgentCapability, AgentResult, AgentRuntime, AgentStatus, AgentTask, DeniedAction, Invocation, RawRun } from './types.js';

export const CLAUDE_CAPABILITIES: AgentCapability[] = ['code', 'review', 'test', 'research', 'long-run'];
// Verified against Claude Code 2.1.319: `claude -p` reads the prompt from stdin and, with `--output-format json`, prints one result object.
const REQUIRED_FLAGS = ['--print', '--output-format', '--permission-mode', '--resume', '--add-dir', '--allowedTools', '--model', '--setting-sources', '--strict-mcp-config'];
/** Not on every 2.x release: without it a prompt that would ask is still refused in print mode, only the flag says so explicitly. */
const OPTIONAL_FLAGS = ['--permission-prompts'];
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_DENIED = 20;

/** The modes `--permission-mode` accepts. `bypassPermissions` is the owner's alone and is reported as a warning (like codex danger-full-access). */
export const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'plan', 'dontAsk', 'manual', 'auto', 'bypassPermissions'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

export interface ClaudeOptions {
  id?: string;
  label?: string;
  model?: string;
  /** Owner setting; `acceptEdits` by default, the counterpart of codex `workspace-write`: edits inside the working directory, commands refused. */
  permissionMode?: ClaudePermissionMode;
  /** `--max-budget-usd` for every run (owner setting). */
  maxBudgetUsd?: number;
  /** Profile environment, for example `CLAUDE_CONFIG_DIR` to run a second signed-in account. */
  env?: Record<string, string>;
  /** The probe saw `--permission-prompts` in the CLI help. */
  permissionPrompts?: boolean;
}

/**
 * The permission rule that allows exactly one refused tool call again: `Bash(<the exact command>)`. Only a shell call gets one, because only its
 * input is an exact string the CLI matches; a file tool refused outside the workspace is answered with `--add-dir` instead.
 */
export function claudeBashRule(denied: DeniedAction): string | null {
  if (denied.action !== 'Bash') return null;
  const command = denied.display_name.startsWith('Bash: ') ? denied.display_name.slice(6) : '';
  // A command that spans lines cannot be written as one exact rule. Inner parentheses are fine: `Bash(node -e "require(\"fs\")...")` matched on 2.1.319.
  if (!command || command.length > 200 || /[\r\n]/.test(command)) return null;
  return `Bash(${command})`;
}

function deniedFrom(list: unknown): DeniedAction[] {
  if (!Array.isArray(list)) return [];
  const denied: DeniedAction[] = [];
  for (const item of list) {
    if (denied.length >= MAX_DENIED) break;
    const value = item as {tool_name?: unknown; tool_input?: Record<string, unknown>} | null;
    const tool = String(value?.tool_name ?? 'tool').slice(0, 60);
    const input = value?.tool_input && typeof value.tool_input === 'object' ? value.tool_input : {};
    const note = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : typeof input.url === 'string' ? input.url : '';
    const display = (note ? `${tool}: ${note}` : tool).slice(0, 260);
    if (!denied.some(entry => entry.display_name === display)) denied.push({action: tool, display_name: display});
  }
  return denied;
}

function finalObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]!) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value) && (value as {type?: unknown}).type === 'result') return value as Record<string, unknown>;
    } catch { /* A line that is not the result object stays in the log only. */ }
  }
  return null;
}

function statsOf(result: Record<string, unknown>): TaskStats | undefined {
  const usage = flattenNumbers(result.usage);
  if (typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)) usage.total_cost_usd = result.total_cost_usd;
  const turns = typeof result.num_turns === 'number' && result.num_turns >= 0 ? result.num_turns : null;
  const duration = typeof result.duration_ms === 'number' && result.duration_ms >= 0 ? result.duration_ms / 1000 : null;
  if (!Object.keys(usage).length && turns === null && duration === null) return undefined;
  return {usage: Object.keys(usage).length ? usage : null, agy_duration_seconds: duration, num_turns: turns, steps: null};
}

export function claudeAdapter(command: ResolvedCommand, options: ClaudeOptions = {}): AgentAdapter {
  return {
    id: options.id ?? 'claude',
    label: options.label ?? 'Claude Code',
    family: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    buildInvocation(task: AgentTask): Invocation {
      // The prompt goes over stdin (argv is capped on Windows and a prompt starting with "-" would be read as a flag); the launcher sets the cwd.
      // `--setting-sources user` keeps the repository's own .claude/settings.json out of the run: measured on 2.1.319, a hook declared there ran
      // in an untrusted workspace without it, which would let repository content execute commands before the agent read a word of the task.
      // `--strict-mcp-config` with no `--mcp-config` starts no MCP server: none from the repository, and not this bridge either, so a delegated
      // task cannot delegate again.
      const args = ['-p', '--output-format', 'json', '--permission-mode', options.permissionMode ?? 'acceptEdits', '--setting-sources', 'user', '--strict-mcp-config'];
      // Nobody can answer a prompt in a bridge run, so anything that would ask is refused at once and reported in permission_denials.
      if (options.permissionPrompts) args.push('--permission-prompts', 'none');
      // The model is the profile's or the owner's (agents.claude_model), resolved in the registry; a task cannot choose it.
      const model = options.model;
      if (model) args.push('--model', model);
      if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd));
      // Validated by the manager: a session this bridge ran, in this workspace, with this family.
      if (task.conversationId) args.push('--resume', task.conversationId);
      // Both flags are variadic, so they come last and carry exactly one value each.
      if (task.elevation?.kind === 'claude-allow-bash') args.push('--allowedTools', task.elevation.rule);
      else if (task.elevation?.kind === 'claude-add-dir') args.push('--add-dir', task.elevation.dir);
      // The runtime's prefixArgs (a Windows shim's .js entry) are prepended by the launcher, as for codex.
      return {executable: command.executable, args, stdin: `${task.prompt}\n`, customEnv: options.env};
    },
    async parseResult(raw: RawRun): Promise<AgentResult> {
      const result = finalObject(raw.stdout);
      const stderrTail = raw.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500);
      if (!result) {
        const error = raw.signal ? `Claude Code was terminated (${raw.signal})` : stderrTail ?? (raw.exitCode === 0 ? 'Claude Code did not print a result object' : `Claude Code exited ${raw.exitCode}`);
        const quota = isQuotaError(raw.stderr) || isStrongQuotaError(raw.stdout);
        return {success: false, response: null, error, cliStatus: quota ? 'quota_exceeded' : null, numTurns: null, deniedActions: [], isQuotaExceeded: quota};
      }
      const text = typeof result.result === 'string' ? result.result.slice(0, MAX_RESPONSE_CHARS).trim() : '';
      const deniedActions = deniedFrom(result.permission_denials);
      const subtype = typeof result.subtype === 'string' ? result.subtype : null;
      const conversationId = typeof result.session_id === 'string' && /^[0-9a-f-]{8,64}$/i.test(result.session_id) ? result.session_id : null;
      const base: AgentResult = {
        success: false, response: text || null, error: null, cliStatus: subtype,
        numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
        deniedActions, stats: statsOf(result), conversationId
      };
      if (result.is_error === true) {
        const status = typeof result.api_error_status === 'number' ? result.api_error_status : null;
        const error = text || (subtype ? `Claude Code stopped: ${subtype}` : 'Claude Code reported an error');
        // 429 is a rate or usage limit and 529 an overloaded API: both are worth the next member of a pool, a 404 model error is not.
        const quota = status === 429 || status === 529 || isQuotaError(error) || /usage limit|hit your limit/i.test(error);
        return {...base, response: null, error, cliStatus: quota ? 'quota_exceeded' : subtype, isQuotaExceeded: quota};
      }
      // Same rule as codex and Antigravity: a refused tool call is a failure even when the CLI exits 0 with a final message.
      if (deniedActions.length) return {...base, error: 'Claude Code was refused a tool call; the owner can rerun it with that one permission from the approval queue'};
      if (raw.exitCode === 0 && text) return {...base, success: true, numTurns: base.numTurns || 1};
      if (raw.signal) return {...base, error: `Claude Code was terminated (${raw.signal})`};
      return {...base, error: stderrTail ?? (raw.exitCode === 0 ? 'Claude Code did not provide a final message' : `Claude Code exited ${raw.exitCode}`)};
    }
  };
}

export function claudeAgent(command: ResolvedCommand, status: AgentStatus, options: ClaudeOptions = {}): AgentRuntime {
  return {adapter: claudeAdapter(command, options), status, enabled: true, prefixArgs: command.prefixArgs};
}

export interface ClaudeProbe extends AgentStatus { permission_prompts: boolean; }

/** Non-interactive `claude -p --output-format json` is the only contract this adapter relies on; the version must be 2.x. */
export async function detectClaude(command: ResolvedCommand, opts: {cwd?: string; extraEnvPassthrough?: string[]} = {}): Promise<ClaudeProbe> {
  const cwd = opts.cwd ?? process.cwd();
  const extra = opts.extraEnvPassthrough ?? [];
  const status = (available: boolean, version: string | null, warnings: string[], permissionPrompts = false): ClaudeProbe => ({
    id: 'claude', label: 'Claude Code', available, version, executable: command.source, capabilities: CLAUDE_CAPABILITIES, warnings,
    conversation_resume: available ? true : undefined, permission_prompts: permissionPrompts
  });
  try {
    const version = await captureOutput('Claude Code', command, ['--version'], cwd, extra);
    const help = await captureOutput('Claude Code', command, ['--help'], cwd, extra);
    const parsed = /(\d+\.\d+\.\d+[^\s]*)/.exec(version.text)?.[1] ?? null;
    if (version.code !== 0) return status(false, null, ['claude --version failed']);
    if (help.code !== 0) return status(false, parsed, ['claude --help failed']);
    if (!parsed || !parsed.startsWith('2.')) return status(false, parsed, [`Claude Code ${parsed ?? '(unknown version)'} is not a 2.x release`]);
    const has = (flag: string) => new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,]|$)`).test(help.text);
    const missing = REQUIRED_FLAGS.filter(flag => !has(flag));
    if (missing.length) return status(false, parsed, [`Claude Code CLI is missing required flags: ${missing.join(', ')}`]);
    const prompts = OPTIONAL_FLAGS.every(has);
    return status(true, parsed, prompts ? [] : ['Claude Code has no --permission-prompts; prompts in print mode are still refused, but not by an explicit flag'], prompts);
  } catch (error) {
    return status(false, null, [`Claude Code CLI could not be inspected: ${error instanceof Error ? error.message : 'unknown error'}`]);
  }
}
