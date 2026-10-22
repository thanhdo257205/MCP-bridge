import { clientToolTimeoutSeconds } from './wait-setting.js';

export type Client = 'codex' | 'claude';
export type Shell = 'powershell' | 'cmd' | 'bash';

export interface SetupInput {
  clients: Client[]; mcpUrl: string; tokenFile: string; tokenFileExists: boolean; tokenFromEnv: boolean; shells: Shell[]; bin: string;
  /** Longest wait the bridge allows per antigravity_task_wait call; Codex's tool timeout must exceed it. Default 55. */
  waitSeconds?: number;
}

const powershell = (text: string) => `'${text.replace(/'/g, "''")}'`;
const posix = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Commands that load the token into BRIDGE_HTTP_TOKEN without ever printing its value. */
function tokenCommands(shell: Shell, tokenFile: string): string {
  if (shell === 'powershell') return `$env:BRIDGE_HTTP_TOKEN = (Get-Content -Raw ${powershell(tokenFile)}).Trim()`;
  if (shell === 'cmd') return `set /p BRIDGE_HTTP_TOKEN=<"${tokenFile}"`;
  return `export BRIDGE_HTTP_TOKEN="$(cat ${posix(tokenFile)})"`;
}
const shellName: Record<Shell, string> = {powershell: 'PowerShell', cmd: 'Command Prompt (cmd)', bash: 'bash / zsh'};

/** The text printed by `setup`. It only prints: nothing here writes to a client's configuration. */
export function renderSetup(input: SetupInput): string {
  const lines: string[] = [];
  const add = (...text: string[]) => lines.push(...text);
  add(`Connect Codex / Claude Code to the bridge at ${input.mcpUrl}`, '(This command only prints; it changes no client configuration. Review, then apply the part you want.)', '');

  add('1. Load the bridge token into the terminal that starts your client');
  if (input.tokenFromEnv) add('   BRIDGE_HTTP_TOKEN is already set in this terminal; the server uses it as the token.');
  else if (!input.tokenFileExists) add(`   The token file does not exist yet. Start the server once (${input.bin}) and it creates ${input.tokenFile}.`);
  for (const shell of input.shells) add(`   ${shellName[shell]}:`, `     ${tokenCommands(shell, input.tokenFile)}`);
  add('   An IDE or desktop app must be restarted from an environment that has this variable; setting it in another terminal does not reach an app that is already running.', '');

  let step = 2;
  if (input.clients.includes('codex')) {
    add(`${step++}. Codex`, '   Either run:', `     codex mcp add antigravity --url ${posix(input.mcpUrl)} --bearer-token-env-var BRIDGE_HTTP_TOKEN`,
      '   or merge this block into ~/.codex/config.toml (or $CODEX_HOME/config.toml); replace an existing [mcp_servers.antigravity] entry instead of adding a second one:',
      '', '     [mcp_servers.antigravity]', `     url = '${input.mcpUrl}'`, "     bearer_token_env_var = 'BRIDGE_HTTP_TOKEN'", '     startup_timeout_sec = 30', `     tool_timeout_sec = ${clientToolTimeoutSeconds(input.waitSeconds ?? 55)}`, '     enabled = true', '',
      '   Check: codex mcp get antigravity   (then ask Codex to call antigravity_environment)', '');
  }
  if (input.clients.includes('claude')) {
    add(`${step++}. Claude Code`, '   Either run (single quotes keep ${BRIDGE_HTTP_TOKEN} unexpanded so the token is not stored in the config):');
    for (const shell of input.shells) {
      const header = shell === 'cmd' ? '"Authorization: Bearer ${BRIDGE_HTTP_TOKEN}"' : `'Authorization: Bearer \${BRIDGE_HTTP_TOKEN}'`;
      const url = shell === 'cmd' ? `"${input.mcpUrl}"` : `'${input.mcpUrl}'`;
      add(`     ${shellName[shell]}:`, `       claude mcp add --transport http --scope local antigravity ${url} --header ${header}`);
    }
    add('   or put this in .mcp.json of the project:', '', '     {', '       "mcpServers": {', '         "antigravity": {', '           "type": "http",', `           "url": "${input.mcpUrl}",`,
      '           "headers": {"Authorization": "Bearer ${BRIDGE_HTTP_TOKEN}"}', '         }', '       }', '     }', '', '   Check: claude mcp get antigravity, and /mcp inside Claude Code.', '');
  }
  add(`${step++}. Install the skill that tells the agent how to delegate (optional but recommended)`);
  for (const client of input.clients) add(`     ${input.bin} skill install --client ${client}`);
  add('', `${step}. Verify the server end to end: ${input.bin} check   (needs the server running and BRIDGE_HTTP_TOKEN loaded)`);
  return lines.join('\n');
}
