import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Edits the MCP client file Freebuff reads (`.agents/mcp.json`) for `setup freebuff --apply`.
 *
 * Deliberately narrow, like codex-config.ts: only the `mcpServers.antigravity` entry is written, every other server
 * is preserved, and any layout this command cannot read with certainty is refused instead of guessed. The file is
 * re-serialized because JSON carries no comments; key order and the file's own indent/newline style are kept, so the
 * diff stays readable. The caller shows the plan and asks before anything is written, and a backup is made first.
 */
export const SERVER_KEY = 'antigravity';

/**
 * `npx` unpacks a package into a cache directory (`.../_npx/<hash>/node_modules/...`) that npm may delete at any time. An
 * absolute path into it must not be written into a client's persistent config: it works today and breaks silently later.
 */
export const isTransientInstall = (packageRoot: string): boolean => /[\\/]_npx[\\/]/.test(packageRoot);

export interface StdioCommand {
  command: string;
  args: string[];
}

/** `~/.agents/mcp.json`, or `<project>/.agents/mcp.json`: Freebuff reads the file nearest to where it runs. */
export const freebuffConfigPath = (options: {project?: string; home?: string} = {}): string =>
  path.join(options.project ?? options.home ?? os.homedir(), '.agents', 'mcp.json');

export type FreebuffPlan =
  | {action: 'none'; reason: string}
  | {action: 'create' | 'update'; text: string; before: string; after: string}
  | {action: 'refuse'; reason: string};

/** The indent the file already uses, so re-serializing it does not reformat the servers someone else wrote. */
function indentOf(text: string): string {
  const match = /\n([ \t]+)"/.exec(text);
  return match?.[1] ?? '  ';
}

export function planFreebuffConfig(existing: string | null, command: StdioCommand): FreebuffPlan {
  const wanted = {command: command.command, args: [...command.args]};
  const rendered = JSON.stringify(wanted);
  const newline = existing?.includes('\r\n') ? '\r\n' : '\n';
  const withNewline = (value: string) => newline === '\n' ? value : value.split('\n').join(newline);
  if (existing === null || existing.trim() === '') {
    const text = withNewline(JSON.stringify({mcpServers: {[SERVER_KEY]: wanted}}, null, 2)) + newline;
    return {action: 'create', text, before: '(no file yet)', after: withNewline(JSON.stringify({[SERVER_KEY]: wanted}, null, 2))};
  }
  let parsed: unknown;
  try { parsed = JSON.parse(existing); }
  catch { return {action: 'refuse', reason: 'the file is not valid JSON'}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {action: 'refuse', reason: 'the file is not a JSON object'};
  }
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return {action: 'refuse', reason: '"mcpServers" is not an object'};
  }
  const map = {...(servers as Record<string, unknown> | undefined ?? {})};
  const indent = indentOf(existing);
  if (map[SERVER_KEY] !== undefined && JSON.stringify(map[SERVER_KEY]) === rendered) {
    return {action: 'none', reason: `the ${SERVER_KEY} entry is already exactly this stdio command`};
  }
  const before = map[SERVER_KEY] === undefined ? `(no ${SERVER_KEY} entry)` : withNewline(JSON.stringify(map[SERVER_KEY], null, indent));
  map[SERVER_KEY] = wanted;
  const text = withNewline(JSON.stringify({...root, mcpServers: map}, null, indent)) + newline;
  return {action: 'update', text, before, after: withNewline(JSON.stringify(wanted, null, indent))};
}

/** Backs the file up, then replaces it atomically. Returns the backup path (null when there was no file). */
export async function writeFreebuffConfig(file: string, plan: Extract<FreebuffPlan, {text: string}>, now = new Date()): Promise<string | null> {
  await mkdir(path.dirname(file), {recursive: true});
  let backup: string | null = null;
  if (plan.action !== 'create') {
    backup = `${file}.bak-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    await copyFile(file, backup);
  }
  await writeFile(`${file}.tmp`, plan.text, {mode: 0o600});
  await rename(`${file}.tmp`, file);
  return backup;
}

export async function readFreebuffConfig(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
