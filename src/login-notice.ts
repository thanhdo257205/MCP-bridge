/** Box shown once in an interactive terminal so a new user can copy the login token without hunting for the file. */
export function tokenNotice(token: string, options: {color: boolean; firstRun: boolean}): string[] {
  const mark = (text: string) => options.color ? `\u001b[1;7m ${text} \u001b[0m` : `>>> ${text} <<<`;
  const rule = '[bridge] ' + '-'.repeat(60);
  return [
    rule,
    options.firstRun ? '[bridge] Login token for the web UI (shown now because it was just created):' : '[bridge] Login token for the web UI (shown because of --show-token):',
    `[bridge]   ${mark(token)}`,
    '[bridge] Paste it on the sign-in page. Treat it like a password: do not share screenshots or recordings of this terminal.',
    `[bridge] Show it again with: agy-mcp-bridge --show-token`,
    rule
  ];
}

/** Only for a person looking at a terminal: never when output is redirected (logs, CI) and never for a token supplied through the environment. */
export function shouldShowToken(options: {created: boolean; requested: boolean; fromFile: boolean; interactive: boolean}): boolean {
  return options.fromFile && options.interactive && (options.created || options.requested);
}
