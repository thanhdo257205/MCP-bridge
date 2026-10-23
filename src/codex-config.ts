import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Edits Codex's config.toml for `setup codex --apply`. Deliberately narrow: it only touches the [mcp_servers.antigravity] table, changes only
 * tool_timeout_sec when the table exists, appends a complete table when there is none, and refuses any layout it cannot read with certainty
 * (the user then edits by hand). The caller shows the plan and asks before anything is written; a backup is made first.
 */
export const MIN_TOOL_TIMEOUT_SECONDS = 60;
export const MAX_TOOL_TIMEOUT_SECONDS = 86400;
/** Above the longest wait the web UI allows (60 minutes), so changing the wait there never needs this file again. */
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 3700;

export const codexConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : path.join(os.homedir(), '.codex'), 'config.toml');

export type CodexPlan =
  | {action: 'none'; reason: string}
  | {action: 'update' | 'append' | 'create'; text: string; before: string; after: string}
  | {action: 'refuse'; reason: string};

const HEADER = /^\s*\[mcp_servers\.antigravity\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;
const TIMEOUT_LINE = /^\s*tool_timeout_sec\s*=/;

export function planCodexConfig(existing: string | null, input: {mcpUrl: string; toolTimeoutSeconds: number}): CodexPlan {
  const value = input.toolTimeoutSeconds;
  if (!Number.isInteger(value) || value < MIN_TOOL_TIMEOUT_SECONDS || value > MAX_TOOL_TIMEOUT_SECONDS) {
    return {action: 'refuse', reason: `the tool timeout must be a whole number of seconds from ${MIN_TOOL_TIMEOUT_SECONDS} to ${MAX_TOOL_TIMEOUT_SECONDS}`};
  }
  const newline = existing !== null && existing.includes('\r\n') ? '\r\n' : '\n';
  const line = `tool_timeout_sec = ${value}`;
  const block = ['[mcp_servers.antigravity]', `url = '${input.mcpUrl.replace(/'/g, '')}'`, "bearer_token_env_var = 'BRIDGE_HTTP_TOKEN'", 'startup_timeout_sec = 30', line, 'enabled = true'];
  if (existing === null) return {action: 'create', text: block.join(newline) + newline, before: '(no file yet)', after: block.join(newline)};
  const lines = existing.split(/\r?\n/);
  const start = lines.findIndex(entry => HEADER.test(entry));
  if (start === -1) {
    if (/mcp_servers[\s\S]{0,40}antigravity/.test(existing)) return {action: 'refuse', reason: 'an antigravity entry exists in a form this command does not rewrite (inline table, dotted or quoted key)'};
    const separator = existing.length === 0 || existing.endsWith('\n') ? (existing.length === 0 ? '' : newline) : newline + newline;
    return {action: 'append', text: existing + separator + block.join(newline) + newline, before: '(no [mcp_servers.antigravity] table)', after: block.join(newline)};
  }
  if (lines.slice(start + 1).some(entry => HEADER.test(entry))) return {action: 'refuse', reason: 'there is more than one [mcp_servers.antigravity] table; remove the extra one first'};
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (ANY_TABLE.test(lines[i])) { end = i; break; }
  const at = lines.slice(start + 1, end).findIndex(entry => TIMEOUT_LINE.test(entry));
  if (at !== -1) {
    const index = start + 1 + at;
    if (lines[index].replace(/\s+#.*$/, '').trim() === line) return {action: 'none', reason: `tool_timeout_sec is already ${value}`};
    const before = lines[index].trim();
    const next = lines.slice(); next[index] = line;
    return {action: 'update', text: next.join(newline), before, after: line};
  }
  let insertAfter = end - 1;
  while (insertAfter > start && lines[insertAfter].trim() === '') insertAfter--;
  const next = lines.slice(); next.splice(insertAfter + 1, 0, line);
  return {action: 'update', text: next.join(newline), before: '(no tool_timeout_sec: Codex uses its 60 s default)', after: line};
}

/** Backs the file up, then replaces it atomically. Returns the backup path (null when there was no file). */
export async function writeCodexConfig(file: string, plan: Extract<CodexPlan, {text: string}>, now = new Date()): Promise<string | null> {
  await mkdir(path.dirname(file), {recursive: true});
  let backup: string | null = null;
  if (plan.action !== 'create') {
    backup = `${file}.bak-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    await copyFile(file, backup);
  }
  await writeFile(`${file}.tmp`, plan.text);
  await rename(`${file}.tmp`, file);
  return backup;
}
export async function readCodexConfig(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
