import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isQuotaError, isStrongQuotaError } from './quota.js';
import type { ResolvedCommand } from '../antigravity/process.js';
import { captureOutput } from './probe.js';
import type { AgentAdapter, AgentCapability, AgentResult, AgentRuntime, AgentStatus, RawRun } from './types.js';

const CAPABILITIES: AgentCapability[] = ['code', 'review', 'test', 'research', 'long-run'];
const REQUIRED_FLAGS = ['--json', '--sandbox', '--cd', '--output-last-message', '--ephemeral', '--skip-git-repo-check'];
const MAX_RESULT_BYTES = 1024 * 1024;

export interface CodexOptions {
  id?: string;
  label?: string;
  model?: string;
  sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only' | string;
  askForApproval?: 'on-request' | 'never' | string;
  env?: Record<string, string>;
}

export function codexAdapter(command: ResolvedCommand, options: CodexOptions = {}): AgentAdapter {
  return {
    id: options.id ?? 'codex',
    label: options.label ?? 'Codex',
    family: 'codex',
    capabilities: CAPABILITIES,
    buildInvocation(task) {
      const resultFile = path.join(task.stateDirectory, 'results', `${task.taskId}.txt`);
      const args = [
        'exec', '--json', '--sandbox', options.sandbox ?? 'workspace-write', '--skip-git-repo-check', '--ephemeral',
        '--cd', task.workspace, '--color', 'never', '-o', resultFile
      ];
      // A global codex flag, so it goes before the `exec` subcommand: `codex exec --ask-for-approval never` exits
      // with "unexpected argument" on codex-cli 0.163.0 and the task never starts.
      if (options.askForApproval) args.unshift('--ask-for-approval', options.askForApproval);
      if (options.model) args.push('-m', options.model);
      args.push('-');
      return {executable: command.executable, args, stdin: `${task.prompt}\n`, resultFile, customEnv: options.env};
    },
    async parseResult(raw: RawRun): Promise<AgentResult> {
      const events: Record<string, unknown>[] = [];
      for (const line of raw.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as unknown;
          if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value as Record<string, unknown>);
        } catch { /* A non-JSON line is kept in the raw log but cannot change the result. */ }
      }
      const errors: string[] = [];
      const messages: string[] = [];
      const deniedActions: AgentResult['deniedActions'] = [];
      let turns = 0;
      let cliStatus: string | null = null;
      for (const event of events) {
        if (event.type === 'error' && typeof event.message === 'string') errors.push(event.message);
        if (event.type === 'turn.completed') {
          turns++;
          cliStatus = typeof event.status === 'string' ? event.status : 'completed';
        }
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === 'item.completed' && item) {
          if (item.type === 'agent_message' && typeof item.text === 'string') messages.push(item.text);
          if (typeof item.status === 'string' && ['declined', 'denied'].includes(item.status)) {
            deniedActions.push({action: 'command', display_name: String(item.command ?? item.type ?? 'declined action').slice(0, 200)});
          }
        }
      }
      let lastMessage = '';
      if (raw.resultFile) {
        try {
          const value = await readFile(raw.resultFile, 'utf8');
          lastMessage = value.slice(0, MAX_RESULT_BYTES);
        } catch { /* The JSONL stream still may carry the final message. */ }
      }
      const response = lastMessage.trim() ? lastMessage : messages.at(-1) ?? null;
      const result: AgentResult = {success: false, response, error: null, cliStatus, numTurns: turns || null, deniedActions};
      // A denied action is a failure even when the CLI exits 0 with a final message.
      if (deniedActions.length) return {...result, error: 'Codex reported a denied action; review the approval policy before retrying'};
      if (raw.exitCode === 0 && response?.trim()) return {...result, success: true, numTurns: turns || 1};
      if (raw.signal) return {...result, error: `Codex was terminated (${raw.signal})`};
      const stderrTail = raw.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
      const finalErr = errors.at(-1) ?? stderrTail?.slice(0, 500) ?? 'Codex did not provide a final message';
      const quotaHit = isQuotaError(raw.stderr) || isQuotaError(finalErr) || isStrongQuotaError(raw.stdout);
      return {...result, error: finalErr, isQuotaExceeded: quotaHit};
    }
  };
}

export function codexAgent(command: ResolvedCommand, status: AgentStatus, options: CodexOptions = {}): AgentRuntime {
  return {adapter: codexAdapter(command, options), status, enabled: true, prefixArgs: command.prefixArgs};
}

/** Non-interactive `codex exec` support is the only contract this adapter relies on. */
export async function detectCodex(command: ResolvedCommand, options: {cwd?: string; extraEnvPassthrough?: string[]} = {}): Promise<AgentStatus> {
  const cwd = options.cwd ?? process.cwd();
  const extra = options.extraEnvPassthrough ?? [];
  const status = (available: boolean, version: string | null, warnings: string[]): AgentStatus => ({
    id: 'codex', label: 'Codex', available, version, executable: command.source, capabilities: CAPABILITIES, warnings
  });
  try {
    const version = await captureOutput('Codex', command, ['--version'], cwd, extra);
    const help = await captureOutput('Codex', command, ['exec', '--help'], cwd, extra);
    const versionText = version.text.trim().split(/\r?\n/)[0] ?? '';
    const parsed = /codex-cli\s+([^\s]+)/i.exec(versionText)?.[1] ?? (versionText || null);
    const missing = REQUIRED_FLAGS.filter(flag => !new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|,|$)`).test(help.text));
    if (version.code !== 0) return status(false, null, ['codex --version failed']);
    if (help.code !== 0) return status(false, parsed, ['codex exec --help failed']);
    if (missing.length) return status(false, parsed, [`Codex CLI is missing required exec flags: ${missing.join(', ')}`]);
    return status(true, parsed, []);
  } catch (error) {
    return status(false, null, [`Codex CLI could not be inspected: ${error instanceof Error ? error.message : 'unknown error'}`]);
  }
}
