import type { ResolvedCommand } from '../antigravity/process.js';
import { flattenNumbers, type TaskStats } from '../usage.js';
import { captureOutput } from './probe.js';
import { isQuotaError, isStrongQuotaError } from './quota.js';
import type { AgentAdapter, AgentCapability, AgentResult, AgentRuntime, AgentStatus, AgentTask, DeniedAction, Invocation, RawRun } from './types.js';

/**
 * Gemini CLI, opt-in, from what could be checked without an account: the flags in `gemini --help` (0.67.0), its JSON formatter and policy engine
 * in the published bundle, and runs with a dummy key. NOT verified with a successful real task, which is why every status it reports carries
 * UNVERIFIED_WARNING. What was measured on 0.67.0:
 * - `-p ""` with the prompt on stdin is accepted (the flag's value is appended to stdin).
 * - Headless refuses an untrusted folder (exit 55) unless `--skip-trust`, so the bridge passes it; without it `--approval-mode` is forced back to `default`.
 * - An error is one pretty-printed JSON object on stderr ({session_id, error: {type, message, code}}) with a non-zero exit (41 no auth, 144 API error).
 * From the bundle: success is one pretty-printed object on stdout ({session_id, response, stats, error?, warnings?}); in non-interactive mode a
 * tool call that would ask is denied by the policy engine ("Tool execution for "<tool>" denied by policy.").
 */
export const GEMINI_CAPABILITIES: AgentCapability[] = ['code', 'review', 'test', 'research', 'long-run'];
const REQUIRED_FLAGS = ['--prompt', '--output-format', '--approval-mode', '--model', '--skip-trust', '--allowed-mcp-server-names'];
const MAX_RESPONSE_CHARS = 1024 * 1024;
/** A server name nobody declares: `--allowed-mcp-server-names` keeps only the servers it names, so none from the repository or the owner starts. */
const NO_MCP_SERVER = '__agy_bridge_no_mcp__';
export const GEMINI_UNVERIFIED_WARNING = 'The Gemini adapter is checked against gemini --help 0.67.0 and its error output only; no real task has been run through it yet';
const POLICY_DENIAL = /Tool execution for "([^"]{1,120})" denied by policy/g;

export const GEMINI_APPROVAL_MODES = ['auto_edit', 'default', 'plan', 'yolo'] as const;
export type GeminiApprovalMode = typeof GEMINI_APPROVAL_MODES[number];

export interface GeminiOptions {
  id?: string;
  label?: string;
  model?: string;
  /** Owner setting; `auto_edit` by default (edit tools approved, everything else denied in headless mode). `yolo` is reported as a warning. */
  approvalMode?: GeminiApprovalMode;
  env?: Record<string, string>;
}

/** The last JSON object in a stream: the CLI pretty-prints it over many lines, possibly after a plain warning line. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.lastIndexOf('\n{'); ; start = text.lastIndexOf('\n{', start - 1)) {
    const from = start < 0 ? text.indexOf('{') : start + 1;
    if (from < 0) return null;
    try {
      const value = JSON.parse(text.slice(from)) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* not the start of the final object; look further back */ }
    if (start < 0) return null;
  }
}

function statsOf(stats: unknown): TaskStats | undefined {
  const value = stats as {models?: Record<string, {tokens?: Record<string, unknown>; api?: {totalRequests?: unknown}}>} | undefined;
  if (!value?.models || typeof value.models !== 'object') return undefined;
  const usage: Record<string, number> = {};
  let requests = 0;
  for (const model of Object.values(value.models)) {
    for (const [key, number] of Object.entries(flattenNumbers(model?.tokens))) usage[key] = (usage[key] ?? 0) + number;
    if (typeof model?.api?.totalRequests === 'number') requests += model.api.totalRequests;
  }
  if (!Object.keys(usage).length && !requests) return undefined;
  return {usage: Object.keys(usage).length ? usage : null, agy_duration_seconds: null, num_turns: requests || null, steps: null};
}

/**
 * An API error arrives as the API's own JSON inside the CLI's message (measured with a rejected key on 0.67.0:
 * {"error":{"message":"{\n  \"error\": {\"code\": 400, \"message\": \"API key not valid...\", \"status\": \"INVALID_ARGUMENT\"...}}"}}).
 * The readable part is the innermost message, with its status and code kept so a 429 is still recognised.
 */
function apiMessage(text: string): string | null {
  let current = text;
  for (let depth = 0; depth < 3; depth++) {
    let parsed: unknown;
    try { parsed = JSON.parse(current); } catch { break; }
    const inner = (parsed as {error?: {message?: unknown; code?: unknown; status?: unknown}} | null)?.error;
    if (!inner || typeof inner.message !== 'string') break;
    const prefix = [typeof inner.status === 'string' ? inner.status : null, typeof inner.code === 'number' ? `(code ${inner.code})` : null].filter(Boolean).join(' ');
    current = inner.message;
    if (prefix && !/^\s*\{/.test(current)) return `${prefix}: ${current}`.slice(0, 1000);
  }
  return current ? current.slice(0, 1000) : null;
}

function deniedFrom(text: string): DeniedAction[] {
  const denied: DeniedAction[] = [];
  for (const match of text.matchAll(POLICY_DENIAL)) {
    const tool = match[1]!;
    if (denied.length < 20 && !denied.some(item => item.action === tool)) denied.push({action: tool, display_name: `${tool}: denied by policy`});
  }
  return denied;
}

export function geminiAdapter(command: ResolvedCommand, options: GeminiOptions = {}): AgentAdapter {
  return {
    id: options.id ?? 'gemini',
    label: options.label ?? 'Gemini CLI',
    family: 'gemini',
    capabilities: GEMINI_CAPABILITIES,
    buildInvocation(task: AgentTask): Invocation {
      // `-p ""` selects headless mode; the prompt itself goes over stdin, which the CLI reads first and appends the (empty) flag value to.
      const args = ['-p', '', '--output-format', 'json', '--approval-mode', options.approvalMode ?? 'auto_edit', '--skip-trust',
        '--allowed-mcp-server-names', NO_MCP_SERVER];
      if (options.model) args.push('--model', options.model);
      return {executable: command.executable, args, stdin: `${task.prompt}\n`, customEnv: options.env};
    },
    async parseResult(raw: RawRun): Promise<AgentResult> {
      const result = lastJsonObject(raw.stdout) ?? lastJsonObject(raw.stderr);
      const stderrTail = raw.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500);
      const denied = deniedFrom(`${raw.stdout}\n${raw.stderr}`);
      const response = typeof result?.response === 'string' ? result.response.slice(0, MAX_RESPONSE_CHARS).trim() : '';
      const error = result?.error as {message?: unknown; code?: unknown; type?: unknown} | undefined;
      const base: AgentResult = {
        success: false, response: response || null, error: null, cliStatus: null, numTurns: null, deniedActions: denied,
        stats: statsOf(result?.stats),
        conversationId: null
      };
      if (error) {
        const message = apiMessage(typeof error.message === 'string' ? error.message : '') ?? 'Gemini CLI reported an error';
        // The API's own status travels inside the message as JSON; 429 / RESOURCE_EXHAUSTED is a quota or rate limit worth the next pool member.
        const quota = /"code"\s*:\s*429|\(code 429\)|RESOURCE_EXHAUSTED/i.test(message) || isQuotaError(message);
        return {...base, error: message, cliStatus: quota ? 'quota_exceeded' : typeof error.code === 'number' ? `error ${error.code}` : null, isQuotaExceeded: quota};
      }
      if (denied.length) return {...base, error: 'Gemini CLI denied a tool call it would have had to ask about; widen the approval mode or the owner\'s Gemini policy before retrying'};
      if (raw.exitCode === 0 && response) return {...base, success: true, numTurns: base.stats?.num_turns ?? 1};
      if (raw.signal) return {...base, error: `Gemini CLI was terminated (${raw.signal})`};
      const quota = isQuotaError(raw.stderr) || isStrongQuotaError(raw.stdout);
      return {...base, error: stderrTail ?? (raw.exitCode === 0 ? 'Gemini CLI did not provide a final message' : `Gemini CLI exited ${raw.exitCode}`),
        isQuotaExceeded: quota, cliStatus: quota ? 'quota_exceeded' : null};
    }
  };
}

export function geminiAgent(command: ResolvedCommand, status: AgentStatus, options: GeminiOptions = {}): AgentRuntime {
  return {adapter: geminiAdapter(command, options), status, enabled: true, prefixArgs: command.prefixArgs};
}

/** Every flag the adapter passes has to be in the CLI's own help; the version is reported, not gated (the CLI is 0.x and moves fast). */
export async function detectGemini(command: ResolvedCommand, opts: {cwd?: string; extraEnvPassthrough?: string[]} = {}): Promise<AgentStatus> {
  const cwd = opts.cwd ?? process.cwd();
  const extra = opts.extraEnvPassthrough ?? [];
  const status = (available: boolean, version: string | null, warnings: string[]): AgentStatus => ({
    id: 'gemini', label: 'Gemini CLI', available, version, executable: command.source, capabilities: GEMINI_CAPABILITIES, warnings
  });
  try {
    const version = await captureOutput('Gemini CLI', command, ['--version'], cwd, extra);
    const help = await captureOutput('Gemini CLI', command, ['--help'], cwd, extra);
    const parsed = /(\d+\.\d+\.\d+[^\s]*)/.exec(version.text)?.[1] ?? null;
    if (version.code !== 0) return status(false, null, ['gemini --version failed']);
    if (help.code !== 0) return status(false, parsed, ['gemini --help failed']);
    const missing = REQUIRED_FLAGS.filter(flag => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,]|$)`).test(help.text));
    if (missing.length) return status(false, parsed, [`Gemini CLI is missing required flags: ${missing.join(', ')}`]);
    return status(true, parsed, [GEMINI_UNVERIFIED_WARNING]);
  } catch (error) {
    return status(false, null, [`Gemini CLI could not be inspected: ${error instanceof Error ? error.message : 'unknown error'}`]);
  }
}
