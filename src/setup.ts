import { clientToolTimeoutSeconds } from './wait-setting.js';
import { SERVER_KEY, type StdioCommand } from './freebuff-config.js';

export type Client = 'codex' | 'claude' | 'freebuff';
export type Shell = 'powershell' | 'cmd' | 'bash';

export interface SetupInput {
  clients: Client[]; mcpUrl: string; shells: Shell[]; bin: string;
  /** Longest wait the bridge allows per antigravity_task_wait call; Codex's tool timeout must exceed it. Default 55. */
  waitSeconds?: number;
  /**
   * How Freebuff starts the bridge over stdio: an absolute interpreter plus the packaged stdio entry.
   * Required (not defaulted) because setup must print the command that really runs this installation.
   */
  stdio: StdioCommand;
}

const posix = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const shellName: Record<Shell, string> = {powershell: 'PowerShell', cmd: 'Command Prompt (cmd)', bash: 'bash / zsh'};

/** The text printed by `setup`. It only prints: nothing here writes to a client's configuration. */
export function renderSetup(input: SetupInput): string {
  const lines: string[] = [];
  const add = (...text: string[]) => lines.push(...text);
  add(`Connect Codex / Claude Code / Freebuff to the bridge at ${input.mcpUrl}`, '(This command only prints; it changes no client configuration. Review, then apply the part you want.)', '');
  add('The bridge has no authentication. It listens on 127.0.0.1 only, so any local process can use it.', '');

  let step = 1;
  if (input.clients.includes('codex')) {
    add(`${step++}. Codex`, '   Either run:', `     codex mcp add antigravity --url ${posix(input.mcpUrl)}`,
      '   or merge this block into ~/.codex/config.toml (or $CODEX_HOME/config.toml); replace an existing [mcp_servers.antigravity] entry instead of adding a second one:',
      '', '     [mcp_servers.antigravity]', `     url = '${input.mcpUrl}'`, '     startup_timeout_sec = 30', `     tool_timeout_sec = ${clientToolTimeoutSeconds(input.waitSeconds ?? 55)}`, '     enabled = true', '',
      '   Check: codex mcp get antigravity   (then ask Codex to call antigravity_environment)',
      `   To only set the tool timeout (and add the entry when it is missing) without editing the file yourself: ${input.bin} setup codex --apply`, '');
  }
  if (input.clients.includes('claude')) {
    add(`${step++}. Claude Code`, '   Either run:');
    for (const shell of input.shells) {
      const url = shell === 'cmd' ? `"${input.mcpUrl}"` : posix(input.mcpUrl);
      add(`     ${shellName[shell]}:`, `       claude mcp add --transport http --scope local antigravity ${url}`);
    }
    add('   or put this in .mcp.json of the project:', '', '     {', '       "mcpServers": {', '         "antigravity": {', '           "type": "http",', `           "url": "${input.mcpUrl}"`, '         }', '       }', '     }', '', '   Check: claude mcp get antigravity, and /mcp inside Claude Code.', '');
  }
  if (input.clients.includes('freebuff')) {
    const entry = JSON.stringify({mcpServers: {[SERVER_KEY]: input.stdio}}, null, 2).split('\n').map(line => `     ${line}`);
    add(`${step++}. Freebuff — MCP client only`,
      "   Freebuff's CLI is an interactive TUI with no headless mode, so the bridge cannot delegate a task to it; it can only be the client.",
      '   Freebuff starts the bridge itself over stdio. Merge this into ~/.agents/mcp.json, or into .agents/mcp.json of the project you open in Freebuff (it reads the nearest of the two):',
      '',
      ...entry,
      '',
      '   That bridge is a child process of Freebuff: closing Freebuff ends it, and a task still running is canceled.',
      `   For a task that must outlive the client, run the HTTP server yourself and point Freebuff at ${input.mcpUrl} instead (rare: only stdio is documented for Freebuff).`,
      `   To write the file for you (a backup is made first): ${input.bin} setup freebuff --apply [--project <dir>]`,
      '   Check: open Freebuff in a project and ask it to call antigravity_environment.', '');
  }
  add(`${step++}. Install the skill that tells the agent how to delegate (optional but recommended)`);
  for (const client of input.clients) {
    if (client === 'freebuff') add(`     ${input.bin} skill install --client codex`,
      '       (Freebuff and Codex both read ~/.agents/skills. The bridge has not verified that Freebuff loads skills from there.)');
    else add(`     ${input.bin} skill install --client ${client}`);
  }
  add('', `${step}. Verify the server end to end: ${input.bin} check   (needs the server running)`);
  return lines.join('\n');
}
