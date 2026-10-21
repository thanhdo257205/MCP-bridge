import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePaths, userDataDirectory } from '../src/paths.js';

test('checkout keeps state next to the code, as before', () => {
  const p = resolvePaths({root: '/work/MCP-bridge/', env: {}});
  assert.equal(p.mode, 'checkout');
  assert.equal(p.configFile, path.join('/work/MCP-bridge/', 'config', 'workspaces.json'));
  assert.equal(p.stateDirectory, path.join('/work/MCP-bridge/', '.bridge-state'));
  assert.equal(p.uiDirectory, path.join('/work/MCP-bridge/', 'ui'));
});
test('an npm install keeps mutable data in the per-user directory, not in node_modules', () => {
  const root = '/usr/lib/node_modules/agy-mcp-bridge/';
  const linux = resolvePaths({root, env: {XDG_CONFIG_HOME: '/home/u/.cfg'}, platform: 'linux', home: '/home/u'});
  assert.equal(linux.mode, 'installed');
  assert.equal(linux.dataDirectory, '/home/u/.cfg/agy-mcp-bridge');
  assert.equal(linux.configFile, path.join('/home/u/.cfg/agy-mcp-bridge', 'workspaces.json'));
  assert.equal(linux.stateDirectory, path.join('/home/u/.cfg/agy-mcp-bridge', 'state'));
  assert.ok(linux.uiDirectory.startsWith(root), 'read-only assets still come from the package');
  assert.equal(userDataDirectory({}, 'linux', '/home/u'), '/home/u/.config/agy-mcp-bridge');
  assert.equal(userDataDirectory({XDG_CONFIG_HOME: 'relative'}, 'linux', '/home/u'), '/home/u/.config/agy-mcp-bridge', 'a relative XDG value is ignored');
  assert.equal(userDataDirectory({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/agy-mcp-bridge');
  assert.equal(userDataDirectory({APPDATA: 'C:\\Users\\u\\AppData\\Roaming'}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\agy-mcp-bridge');
  assert.equal(userDataDirectory({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\agy-mcp-bridge');
});
test('BRIDGE_HOME overrides the location in either mode and must be absolute', () => {
  const home = path.resolve('/srv/bridge-data');
  for (const root of ['/work/MCP-bridge/', '/usr/lib/node_modules/agy-mcp-bridge/']) {
    const p = resolvePaths({root, env: {BRIDGE_HOME: home}});
    assert.equal(p.dataDirectory, home);
    assert.equal(p.configFile, path.join(home, 'workspaces.json'));
    assert.equal(p.stateDirectory, path.join(home, 'state'));
  }
  assert.equal(resolvePaths({root: '/work/MCP-bridge/', env: {BRIDGE_HOME: home}}).mode, 'checkout');
  assert.throws(() => resolvePaths({root: '/work/x/', env: {BRIDGE_HOME: 'relative/dir'}}), /absolute/);
  assert.equal(resolvePaths({root: '/work/x/', env: {BRIDGE_HOME: ''}}).dataDirectory, '/work/x/', 'empty means unset');
});
