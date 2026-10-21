import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'dist', 'src', 'cli.js');
const version = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {version: string}).version;
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...process.env, BRIDGE_NO_UPDATE_CHECK: '1', ...env}});
const home = () => mkdtemp(path.join(tmpdir(), 'bridge-cli-'));

test('cli: version, help, unknown command', () => {
  assert.equal(run(['--version']).stdout.trim(), version);
  assert.equal(run(['version']).stdout.trim(), version);
  const help = run(['help']).stdout;
  for (const word of ['start', 'workspaces', 'delegation', 'skill install', 'update', 'config', 'BRIDGE_HOME']) assert.match(help, new RegExp(word));
  const bad = run(['frobnicate']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown command: frobnicate/);
});
test('cli: config reports locations without printing the token', async () => {
  const dir = await home();
  const out = JSON.parse(run(['config', '--json'], {BRIDGE_HOME: dir, BRIDGE_HTTP_TOKEN: 'x'.repeat(40)}).stdout) as Record<string, string>;
  assert.equal(out.data_directory, dir);
  assert.equal(out.config_file, path.join(dir, 'workspaces.json'));
  assert.equal(out.state_directory, path.join(dir, 'state'));
  assert.equal(out.token_file, path.join(dir, 'state', 'http-token'));
  assert.equal(out.version, version);
  assert.ok(!JSON.stringify(out).includes('x'.repeat(40)));
  assert.match(run(['config'], {BRIDGE_HOME: dir}).stdout, /config file: /);
});
test('cli: workspaces add / list / remove edit the config in the data directory', async () => {
  const dir = await home();
  const project = path.join(dir, 'project'); await mkdir(project);
  const env = {BRIDGE_HOME: path.join(dir, 'data')};
  assert.match(run(['workspaces', 'list'], env).stdout, /\(none\)/);
  const added = run(['workspaces', 'add', project], env);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /Added: /);
  assert.match(run(['workspaces', 'list'], env).stdout, /project/);
  assert.match(run(['workspaces', 'add', project], env).stdout, /Already allowed/);
  assert.equal(run(['workspaces', 'add', path.join(dir, 'missing')], env).status, 1);
  assert.equal(run(['workspaces', 'add', root], env).status, 1, 'the bridge source tree is refused');
  assert.match(run(['workspaces', 'remove', project], env).stdout, /Removed/);
  assert.match(run(['workspaces', 'list'], env).stdout, /\(none\)/);
  assert.equal(run(['workspaces'], env).status, 1);
});
test('cli: delegation switch works through the data directory', async () => {
  const env = {BRIDGE_HOME: await home()};
  assert.match(run(['delegation', 'status'], env).stdout, /ENABLED/);
  assert.match(run(['delegation', 'off'], env).stdout, /DISABLED/);
  assert.match(run(['delegation', 'status'], env).stdout, /DISABLED/);
  assert.match(run(['delegation', 'on'], env).stdout, /ENABLED/);
});
test('cli: start serves the UI, keeps state in BRIDGE_HOME, and announces an update without changing anything', async () => {
  const data = await home();
  const hits: string[] = [];
  const registry = createServer((req, res) => { hits.push(req.url ?? ''); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({version: '99.0.0'})); });
  await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
  const token = 'cli_test_token_123456789012345678901234567';
  const env: NodeJS.ProcessEnv = {...process.env, BRIDGE_HOME: data, BRIDGE_HTTP_TOKEN: token, PORT: '0', BRIDGE_UPDATE_CHECK: 'force',
    BRIDGE_UPDATE_REGISTRY: `http://127.0.0.1:${(registry.address() as {port: number}).port}`};
  delete env.BRIDGE_NO_UPDATE_CHECK; delete env.CI;
  await writeFile(path.join(data, 'workspaces.json'), JSON.stringify({allowed_workspaces: [], executable: path.join(data, 'missing')}));
  const child = spawn(process.execPath, [cli, 'start'], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stderr.on('data', chunk => log += chunk); child.stdout.on('data', chunk => log += chunk);
  try {
    const until = Date.now() + 10000;
    while (!(/MCP endpoint:/.test(log) && /Update available/.test(log)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    const base = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(log)?.[1];
    assert.ok(base, log);
    assert.match(log, /\[update\] agy-mcp-bridge 99\.0\.0 is available/, 'announced before starting');
    assert.match(log, /Update available: agy-mcp-bridge 99\.0\.0/, 'announced while running');
    assert.equal((await fetch(`${base}/ui`)).status, 200);
    assert.ok(log.includes(`[bridge] Web UI: ${base}/ui`), 'the terminal shows the link to the web UI');
    const login = await (await fetch(`${base}/ui/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token})})).json() as {session: string};
    const overview = await (await fetch(`${base}/ui/api/overview`, {headers: {'x-bridge-session': login.session}})).json() as {update: {latest: string; command: string}};
    assert.equal(overview.update.latest, '99.0.0');
    assert.equal(overview.update.command, 'agy-mcp-bridge update');
    assert.equal(hits.length, 1, 'one registry lookup serves both the start-up notice and the running server');
    assert.ok(await readFile(path.join(data, 'state', 'update-check.json'), 'utf8'));
    assert.ok(!log.includes(token));
  } finally {
    child.kill('SIGINT'); await new Promise(resolve => child.once('close', resolve)); registry.close();
  }
});
test('cli: --no-update-check makes no registry request', async () => {
  const data = await home();
  let hits = 0;
  const registry = createServer((_req, res) => { hits++; res.end('{}'); });
  await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = {...process.env, BRIDGE_HOME: data, BRIDGE_HTTP_TOKEN: 'cli_test_token_123456789012345678901234567', PORT: '0',
    BRIDGE_UPDATE_REGISTRY: `http://127.0.0.1:${(registry.address() as {port: number}).port}`};
  delete env.BRIDGE_UPDATE_CHECK; delete env.BRIDGE_NO_UPDATE_CHECK; delete env.CI;
  await writeFile(path.join(data, 'workspaces.json'), JSON.stringify({allowed_workspaces: [], executable: path.join(data, 'missing')}));
  // Without the flag a checkout would not check anyway, so force the check on and prove the flag alone turns it off.
  env.BRIDGE_UPDATE_CHECK = 'force';
  const child = spawn(process.execPath, [cli, 'start', '--no-update-check'], {env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stderr.on('data', chunk => log += chunk);
  try {
    const until = Date.now() + 10000;
    while (!/MCP endpoint:/.test(log) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(log, /MCP endpoint:/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(hits, 0);
  } finally { child.kill('SIGINT'); await new Promise(resolve => child.once('close', resolve)); registry.close(); }
});
async function startWith(args: string[], options: {cwd?: string; data: string}) {
  const token = 'cli_test_token_123456789012345678901234567';
  const env: NodeJS.ProcessEnv = {...process.env, BRIDGE_HOME: options.data, BRIDGE_HTTP_TOKEN: token, PORT: '0', BRIDGE_NO_UPDATE_CHECK: '1'};
  await mkdir(options.data, {recursive: true});
  await writeFile(path.join(options.data, 'workspaces.json'), JSON.stringify({allowed_workspaces: [], executable: path.join(options.data, 'missing')}));
  const child = spawn(process.execPath, [cli, 'start', ...args], {env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stderr.on('data', chunk => log += chunk); child.stdout.on('data', chunk => log += chunk);
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  const until = Date.now() + 10000;
  while (!/MCP endpoint:/.test(log) && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  const base = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(log)?.[1];
  const overview = async () => {
    const login = await (await fetch(`${base}/ui/api/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token})})).json() as {session: string};
    return await (await fetch(`${base}/ui/api/overview`, {headers: {'x-bridge-session': login.session}})).json() as {allowed_workspaces: string[]; session_workspaces: string[]};
  };
  const stop = async () => { child.kill('SIGINT'); return exited; };
  return {log: () => log, base, overview, stop, exited};
}

test('cli: start --workspace allows a directory for this run only, including "." as the current directory', async () => {
  const dir = await home();
  const project = path.join(dir, 'My Project'); await mkdir(project);
  const other = path.join(dir, 'other'); await mkdir(other);
  const server = await startWith(['--workspace', '.', '--workspace', other], {cwd: project, data: path.join(dir, 'data')});
  try {
    assert.ok(server.base, server.log());
    const overview = await server.overview();
    const real = (await import('node:fs/promises')).realpath;
    assert.deepEqual(overview.allowed_workspaces, [await real(project), await real(other)]);
    assert.deepEqual(overview.session_workspaces, overview.allowed_workspaces);
    assert.match(server.log(), /allowed for this run only \(not saved\)/);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'data', 'workspaces.json'), 'utf8')).allowed_workspaces, [], 'nothing was saved');
  } finally { await server.stop(); }
});
test('cli: start --workspace refuses a bad directory before the server starts', async () => {
  const dir = await home();
  for (const bad of [path.join(dir, 'missing'), root]) {
    const server = await startWith(['--workspace', bad], {data: path.join(dir, 'data')});
    assert.equal(await server.exited, 1);
    assert.equal(server.base, undefined, 'no server was started');
    assert.match(server.log(), /does not exist|bridge installation/);
  }
  const server = await startWith(['--workspace'], {data: path.join(dir, 'data')});
  assert.equal(await server.exited, 1);
  assert.match(server.log(), /--workspace needs a value/);
});
