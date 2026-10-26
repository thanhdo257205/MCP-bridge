import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSetup, type SetupInput } from '../src/setup.js';

const base: SetupInput = {clients: ['codex', 'claude'], mcpUrl: 'http://127.0.0.1:3000/mcp', shells: ['bash'], bin: 'agy-mcp-bridge'};

test('setup: prints both clients, no credentials, and the skill hint', () => {
  const text = renderSetup(base);
  assert.match(text, /codex mcp add antigravity --url 'http:\/\/127\.0\.0\.1:3000\/mcp'/);
  assert.match(text, /\[mcp_servers\.antigravity\]/);
  assert.doesNotMatch(text, /bearer_token_env_var/);
  assert.match(text, /claude mcp add --transport http --scope local antigravity 'http:\/\/127\.0\.0\.1:3000\/mcp'/);
  assert.doesNotMatch(text, /Authorization|BRIDGE_HTTP_TOKEN/);
  assert.match(text, /"mcpServers"/);
  assert.match(text, /skill install --client codex/);
  assert.match(text, /skill install --client claude/);
  assert.match(text, /changes no client configuration/);
  assert.match(text, /no authentication/);
});
test('setup: one client only prints that client', () => {
  const codex = renderSetup({...base, clients: ['codex']});
  assert.match(codex, /codex mcp add/); assert.doesNotMatch(codex, /claude mcp add/); assert.doesNotMatch(codex, /skill install --client claude/);
  const claude = renderSetup({...base, clients: ['claude']});
  assert.match(claude, /claude mcp add/); assert.doesNotMatch(claude, /codex mcp add/);
});
test('setup: quotes the URL per shell and a quote in the URL cannot break out', () => {
  const tricky = "http://127.0.0.1:3000/mcp?x='y";
  const sh = renderSetup({...base, clients: ['claude'], shells: ['bash'], mcpUrl: tricky});
  assert.ok(sh.includes(`claude mcp add --transport http --scope local antigravity 'http://127.0.0.1:3000/mcp?x='\\''y'`));
  const cmd = renderSetup({...base, clients: ['claude'], shells: ['cmd'], mcpUrl: 'http://127.0.0.1:3000/mcp'});
  assert.match(cmd, /antigravity "http:\/\/127\.0\.0\.1:3000\/mcp"/);
});
test('setup: explains the local trust model and never contains a credential', () => {
  assert.match(renderSetup(base), /any local process can use it/);
  assert.ok(!/Bearer [A-Za-z0-9_-]{20,}/.test(renderSetup(base)));
  assert.match(renderSetup({...base, mcpUrl: 'http://127.0.0.1:3555/mcp'}), /127\.0\.0\.1:3555\/mcp/);
});
