import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSetup, type SetupInput } from '../src/setup.js';

const base: SetupInput = {clients: ['codex', 'claude'], mcpUrl: 'http://127.0.0.1:3000/mcp', tokenFile: '/home/u/.config/agy-mcp-bridge/state/http-token', tokenFileExists: true, tokenFromEnv: false, shells: ['bash'], bin: 'agy-mcp-bridge'};

test('setup: prints both clients, the token loading command and the skill hint', () => {
  const text = renderSetup(base);
  assert.match(text, /codex mcp add antigravity --url 'http:\/\/127\.0\.0\.1:3000\/mcp' --bearer-token-env-var BRIDGE_HTTP_TOKEN/);
  assert.match(text, /\[mcp_servers\.antigravity\]/);
  assert.match(text, /bearer_token_env_var = 'BRIDGE_HTTP_TOKEN'/);
  assert.match(text, /claude mcp add --transport http --scope local antigravity 'http:\/\/127\.0\.0\.1:3000\/mcp' --header 'Authorization: Bearer \$\{BRIDGE_HTTP_TOKEN\}'/);
  assert.match(text, /"mcpServers"/);
  assert.match(text, /export BRIDGE_HTTP_TOKEN="\$\(cat '\/home\/u\/\.config\/agy-mcp-bridge\/state\/http-token'\)"/);
  assert.match(text, /skill install --client codex/);
  assert.match(text, /skill install --client claude/);
  assert.match(text, /changes no client configuration/);
});
test('setup: one client only prints that client', () => {
  const codex = renderSetup({...base, clients: ['codex']});
  assert.match(codex, /codex mcp add/); assert.doesNotMatch(codex, /claude mcp add/); assert.doesNotMatch(codex, /skill install --client claude/);
  const claude = renderSetup({...base, clients: ['claude']});
  assert.match(claude, /claude mcp add/); assert.doesNotMatch(claude, /codex mcp add/);
});
test('setup: token commands are quoted per shell and a quote in the path cannot break out', () => {
  const tricky = "C:\\Users\\o'brien\\token";
  const ps = renderSetup({...base, shells: ['powershell'], tokenFile: tricky});
  assert.match(ps, /\$env:BRIDGE_HTTP_TOKEN = \(Get-Content -Raw 'C:\\Users\\o''brien\\token'\)\.Trim\(\)/);
  const sh = renderSetup({...base, shells: ['bash'], tokenFile: "/tmp/o'brien/token"});
  assert.ok(sh.includes(`export BRIDGE_HTTP_TOKEN="$(cat '/tmp/o'\\''brien/token')"`));
  const cmd = renderSetup({...base, shells: ['cmd'], tokenFile: 'C:\\Users\\me\\token'});
  assert.match(cmd, /set \/p BRIDGE_HTTP_TOKEN=<"C:\\Users\\me\\token"/);
  assert.match(cmd, /--header "Authorization: Bearer \$\{BRIDGE_HTTP_TOKEN\}"/);
});
test('setup: explains a missing token file and an already-set variable, and never contains a token value', () => {
  assert.match(renderSetup({...base, tokenFileExists: false}), /token file does not exist yet.*creates/);
  assert.match(renderSetup({...base, tokenFromEnv: true}), /already set in this terminal/);
  assert.ok(!/Bearer [A-Za-z0-9_-]{20,}/.test(renderSetup(base)));
  assert.match(renderSetup({...base, mcpUrl: 'http://127.0.0.1:3555/mcp'}), /127\.0\.0\.1:3555\/mcp/);
});
