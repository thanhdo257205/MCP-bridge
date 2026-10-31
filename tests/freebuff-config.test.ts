import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freebuffConfigPath, isTransientInstall, planFreebuffConfig, readFreebuffConfig, writeFreebuffConfig, type FreebuffPlan } from '../src/freebuff-config.js';

const command = {command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\bridge\\dist\\src\\stdio.js']};
const wanted = {command: command.command, args: command.args};
const plan = (text: string | null) => planFreebuffConfig(text, command);
const textOf = (value: FreebuffPlan) => { assert.ok('text' in value, JSON.stringify(value)); return value.text; };

test('freebuff config: no file creates exactly one server, and the entry is the resolved stdio command', () => {
  const created = plan(null);
  assert.equal(created.action, 'create');
  assert.equal(created.before, '(no file yet)');
  assert.deepEqual(JSON.parse(textOf(created)), {mcpServers: {antigravity: wanted}});
  assert.equal(textOf(created).split('\n').length > 3, true, 'pretty-printed, not one long line');
  assert.equal(plan('   \n').action, 'create', 'a blank file is treated as no file');
});

test('freebuff config: every other server and every other key is preserved, byte semantics intact', () => {
  const before = JSON.stringify({
    $schema: 'https://example.test/mcp.json',
    mcpServers: {
      other: {command: 'other-bin', args: ['--flag'], env: {TOKEN: 'x'}},
      antigravity: {command: 'old-node', args: ['old.js']}
    }
  }, null, 2) + '\n';
  const updated = plan(before);
  assert.equal(updated.action, 'update');
  assert.match(updated.before, /old-node/);
  const after = JSON.parse(textOf(updated));
  assert.deepEqual(after.$schema, 'https://example.test/mcp.json', 'unrelated top-level keys survive');
  assert.deepEqual(after.mcpServers.other, {command: 'other-bin', args: ['--flag'], env: {TOKEN: 'x'}}, 'another server survives unchanged');
  assert.deepEqual(after.mcpServers.antigravity, wanted);
});

test('freebuff config: an entry without mcpServers is created; the file\'s own indent and CRLF are kept', () => {
  const four = '{\n    "note": "x"\n}';
  const created = textOf(plan(four));
  assert.ok(created.includes('\n    "mcpServers"'), `indent not reused: ${created}`);
  const crlf = '{\r\n  "mcpServers": {\r\n    "other": {\r\n      "command": "x"\r\n    }\r\n  }\r\n}\r\n';
  const out = textOf(plan(crlf));
  assert.ok(out.includes('\r\n'), 'the file stays CRLF');
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF is introduced into a CRLF file');
  assert.deepEqual(JSON.parse(out).mcpServers.other, {command: 'x'});
});

test('freebuff config: the exact entry is "nothing to do"; a differing one is replaced', () => {
  const same = JSON.stringify({mcpServers: {antigravity: wanted}}, null, 2);
  const none = plan(same);
  assert.equal(none.action, 'none');
  const extra = JSON.stringify({mcpServers: {antigravity: {...wanted, env: {A: 'b'}}}}, null, 2);
  assert.equal(plan(extra).action, 'update', 'extra keys on the entry mean it is not what we would write');
});

test('freebuff config: layouts it cannot read with certainty are refused, never guessed', () => {
  assert.equal(plan('{broken').action, 'refuse');
  assert.equal(plan('[]').action, 'refuse');
  assert.equal(plan('"text"').action, 'refuse');
  assert.equal(plan('null').action, 'refuse');
  assert.equal(plan('{"mcpServers": "nope"}').action, 'refuse');
  assert.equal(plan('{"mcpServers": []}').action, 'refuse');
});

test('freebuff config: a backup is taken before the file is replaced, and no temp file is left behind', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-freebuff-'));
  const file = path.join(dir, '.agents', 'mcp.json');
  assert.equal(await readFreebuffConfig(file), null, 'a missing file reads as null, not an error');
  const createdPlan = plan(null);
  assert.equal(await writeFreebuffConfig(file, createdPlan as Extract<FreebuffPlan, {text: string}>), null, 'nothing to back up for a new file');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {mcpServers: {antigravity: wanted}});

  const existing = JSON.stringify({mcpServers: {other: {command: 'x'}, antigravity: {command: 'stale'}}}, null, 2);
  await writeFile(file, existing);
  const updatePlan = plan(await readFreebuffConfig(file));
  const backup = await writeFreebuffConfig(file, updatePlan as Extract<FreebuffPlan, {text: string}>, new Date('2026-10-31T09:08:07Z'));
  assert.equal(path.basename(String(backup)), 'mcp.json.bak-20261031090807');
  assert.equal(await readFile(String(backup), 'utf8'), existing, 'the backup is the file as it was');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers.other, {command: 'x'});
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['mcp.json', 'mcp.json.bak-20261031090807'], 'no temp file left behind');
});

test('freebuff config: the path is the file Freebuff reads, for the project or for the user', () => {
  assert.equal(freebuffConfigPath({home: '/home/u'}), path.join('/home/u', '.agents', 'mcp.json'));
  assert.equal(freebuffConfigPath({project: '/repo', home: '/home/u'}), path.join('/repo', '.agents', 'mcp.json'), 'a project wins');
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'dist', 'src', 'cli.js');
const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', input: '', env: {...process.env, BRIDGE_NO_UPDATE_CHECK: '1', ...env}});

test('cli: setup freebuff prints without writing, and --apply writes only after --yes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'agy-cli-home-'));
  const project = await mkdtemp(path.join(tmpdir(), 'agy-cli-project-'));
  const env = {BRIDGE_HOME: home};
  const printed = run(['setup', 'freebuff', '--project', path.join(project, 'missing')], env);
  assert.equal(printed.status, 1, '--project with printing only is refused instead of silently ignored');

  const out = run(['setup', 'freebuff'], env);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\.agents\/mcp\.json/);
  assert.match(out.stdout, /no headless mode/, 'the printed text says why Freebuff is a client, not an agent');
  assert.equal((await readdir(project)).length, 0, 'printing changed nothing');

  const file = path.join(project, '.agents', 'mcp.json');
  const unattended = run(['setup', 'freebuff', '--apply', '--project', project], env);
  assert.equal(unattended.status, 1);
  assert.match(unattended.stderr, /not an interactive terminal/);
  assert.equal(await readFreebuffConfig(file), null, 'nothing written without confirmation');

  const applied = run(['setup', 'freebuff', '--apply', '--project', project, '--yes'], env);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Backup:|Done \(file created\)/);
  const written = JSON.parse(String(await readFreebuffConfig(file)));
  const entry = written.mcpServers.antigravity;
  assert.deepEqual(entry.args, [path.join(root, 'dist', 'src', 'stdio.js')], 'the entry names this installation');
  assert.match(entry.command, /node/i);
  assert.ok(existsSync(entry.args[0]), 'the path the entry names is really the packaged stdio entry');

  assert.match(run(['setup', 'freebuff', '--apply', '--project', project, '--yes'], env).stdout, /Nothing to do/);
  assert.equal(run(['setup', 'codex', '--apply', '--project', project, '--yes'], env).status, 1, '--project is Freebuff-only');
});

test('freebuff config: only a path inside the npx cache counts as a transient install', () => {
  const windows = (...parts: string[]) => parts.join(String.fromCharCode(92));
  for (const transient of [windows('C:', 'Users', 'u', 'AppData', 'Local', 'npm-cache', '_npx', '1a2b3c', 'node_modules', 'agy-mcp-bridge', ''), '/home/u/.npm/_npx/1a2b3c/node_modules/agy-mcp-bridge/']) {
    assert.equal(isTransientInstall(transient), true, transient);
  }
  for (const stable of [windows('C:', 'Users', 'u', 'AppData', 'Roaming', 'npm', 'node_modules', 'agy-mcp-bridge', ''), '/usr/local/lib/node_modules/agy-mcp-bridge/', windows('C:', 'work', 'MCP-bridge', ''), '/home/u/my_npx_tools/agy-mcp-bridge/']) {
    assert.equal(isTransientInstall(stable), false, stable);
  }
});

test('cli: setup freebuff --apply refuses to write a path into a temporary npx copy, and printing warns about it', async () => {
  // A copy of the packaged CLI under .../_npx/<hash>/node_modules/<name>/, the way npx lays a package out.
  const base = await mkdtemp(path.join(tmpdir(), 'agy-npx-copy-'));
  const copy = path.join(base, '_npx', 'abc123', 'node_modules', 'agy-mcp-bridge');
  await mkdir(path.join(copy, 'dist'), {recursive: true});
  for (const part of ['src', 'scripts']) cpSync(path.join(root, 'dist', part), path.join(copy, 'dist', part), {recursive: true});
  cpSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'junction');
  const copiedCli = path.join(copy, 'dist', 'src', 'cli.js');
  const home = await mkdtemp(path.join(tmpdir(), 'agy-cli-home-'));
  const project = await mkdtemp(path.join(tmpdir(), 'agy-cli-project-'));
  const env = {...process.env, BRIDGE_NO_UPDATE_CHECK: '1', BRIDGE_HOME: home};
  const exec = (args: string[]) => spawnSync(process.execPath, [copiedCli, ...args], {encoding: 'utf8', input: '', env});

  const applied = exec(['setup', 'freebuff', '--apply', '--project', project, '--yes']);
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /temporary npx cache/);
  assert.match(applied.stderr, /npm install -g/);
  assert.equal(existsSync(path.join(project, '.agents', 'mcp.json')), false, 'nothing was written');

  const printed = exec(['setup', 'freebuff']);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stderr, /temporary npx cache/);
  assert.match(printed.stdout, /stdio\.js/, 'the command is still printed so the owner can see it');
});
