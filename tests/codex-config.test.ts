import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TOOL_TIMEOUT_SECONDS, codexConfigPath, planCodexConfig, writeCodexConfig, type CodexPlan } from '../src/codex-config.js';

const url='http://127.0.0.1:3000/mcp';
const plan=(text:string|null,seconds=3700)=>planCodexConfig(text,{mcpUrl:url,toolTimeoutSeconds:seconds});
const textOf=(p:CodexPlan)=>{assert.ok('text' in p,JSON.stringify(p));return p.text;};

test('codex config: an existing table gets only its tool_timeout_sec replaced; everything else is byte for byte the same',()=>{
  const before=['model = "gpt-5"','','[mcp_servers.antigravity]',"url = 'http://127.0.0.1:3000/mcp'",'tool_timeout_sec = 115 # old','enabled = true','','[mcp_servers.other]','tool_timeout_sec = 5',''].join('\n');
  const p=plan(before);assert.equal(p.action,'update');
  assert.equal(textOf(p),before.replace('tool_timeout_sec = 115 # old','tool_timeout_sec = 3700'),'the other table keeps its own tool_timeout_sec');
});
test('codex config: a table without the setting gets it after its last key, before the next table',()=>{
  const before="[mcp_servers.antigravity]\nurl = 'x'\nenabled = true\n\n[other]\na = 1\n";
  assert.equal(textOf(plan(before)),"[mcp_servers.antigravity]\nurl = 'x'\nenabled = true\ntool_timeout_sec = 3700\n\n[other]\na = 1\n");
});
test('codex config: the same value is "nothing to do"; CRLF files stay CRLF',()=>{
  assert.equal(plan("[mcp_servers.antigravity]\ntool_timeout_sec = 3700\n").action,'none');
  const crlf="[mcp_servers.antigravity]\r\nurl = 'x'\r\ntool_timeout_sec = 60\r\n";
  const out=textOf(plan(crlf));assert.equal(out,"[mcp_servers.antigravity]\r\nurl = 'x'\r\ntool_timeout_sec = 3700\r\n");assert.ok(!/[^\r]\n/.test(out));
  assert.ok(textOf(plan("[a]\r\nb=1\r\n")).includes('\r\n[mcp_servers.antigravity]\r\n'));
});
test('codex config: no entry appends a complete table; no file creates one; layouts it cannot read are refused',()=>{
  const appended=textOf(plan('model = "x"'));
  assert.match(appended,/^model = "x"\n\n\[mcp_servers\.antigravity\]\nurl = 'http:\/\/127\.0\.0\.1:3000\/mcp'\nbearer_token_env_var = 'BRIDGE_HTTP_TOKEN'\nstartup_timeout_sec = 30\ntool_timeout_sec = 3700\nenabled = true\n$/);
  const created=plan(null);assert.equal(created.action,'create');assert.match(textOf(created),/^\[mcp_servers\.antigravity\]/);
  assert.equal(plan('mcp_servers.antigravity = {url = "x"}\n').action,'refuse');
  assert.equal(plan('[mcp_servers."antigravity"]\nurl="x"\n').action,'refuse');
  assert.equal(plan('[mcp_servers.antigravity]\na=1\n[mcp_servers.antigravity]\nb=2\n').action,'refuse');
  for(const bad of [59,86401,60.5,Number.NaN])assert.equal(plan('',bad).action,'refuse',String(bad));
  assert.equal(DEFAULT_TOOL_TIMEOUT_SECONDS,3700);
});
test('codex config: CODEX_HOME decides the location; a backup is made before the file is replaced',async()=>{
  assert.equal(codexConfigPath({CODEX_HOME:'/x/codex'} as NodeJS.ProcessEnv),path.join('/x/codex','config.toml'));
  assert.match(codexConfigPath({} as NodeJS.ProcessEnv),/\.codex[\\/]config\.toml$/);
  const dir=await mkdtemp(path.join(tmpdir(),'agy-codex-'));const file=path.join(dir,'config.toml');
  await writeFile(file,"[mcp_servers.antigravity]\ntool_timeout_sec = 60\n");
  const p=plan(await readFile(file,'utf8'));assert.ok('text' in p);
  const backup=await writeCodexConfig(file,p as Extract<CodexPlan,{text:string}>,new Date('2026-10-22T12:34:56Z'));
  assert.equal(path.basename(String(backup)),'config.toml.bak-20261022123456');
  assert.equal(await readFile(String(backup),'utf8'),"[mcp_servers.antigravity]\ntool_timeout_sec = 60\n");
  assert.equal(await readFile(file,'utf8'),"[mcp_servers.antigravity]\ntool_timeout_sec = 3700\n");
  assert.deepEqual((await readdir(dir)).sort(),['config.toml','config.toml.bak-20261022123456'],'no temp file left behind');
});

const root=fileURLToPath(new URL('../../',import.meta.url));const cli=path.join(root,'dist','src','cli.js');
const run=(args:string[],env:NodeJS.ProcessEnv)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',input:'',env:{...process.env,BRIDGE_NO_UPDATE_CHECK:'1',...env}});
test('cli: setup codex --apply writes after --yes, refuses without a terminal, and rejects claude',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'agy-cli-home-'));const codex=await mkdtemp(path.join(tmpdir(),'agy-cli-codex-'));const file=path.join(codex,'config.toml');
  const env={BRIDGE_HOME:home,CODEX_HOME:codex};
  await writeFile(file,"[mcp_servers.antigravity]\nurl = 'x'\n");
  const noTerminal=run(['setup','codex','--apply'],env);assert.equal(noTerminal.status,1);assert.match(noTerminal.stderr,/not an interactive terminal/);
  assert.equal(await readFile(file,'utf8'),"[mcp_servers.antigravity]\nurl = 'x'\n",'nothing written without confirmation');
  const done=run(['setup','codex','--apply','--yes'],env);assert.equal(done.status,0,done.stderr);
  assert.match(done.stdout,/before: .*60 s default/);assert.match(done.stdout,/after:\s+tool_timeout_sec = 3700/);assert.match(done.stdout,/Backup:/);
  assert.match(await readFile(file,'utf8'),/tool_timeout_sec = 3700/);
  assert.match(run(['setup','codex','--apply','--yes'],env).stdout,/Nothing to do/);
  assert.equal(run(['setup','claude','--apply','--yes'],env).status,1);
  assert.match(run(['setup','codex','--apply','--yes','--tool-timeout','30'],env).stderr,/whole number of seconds/);
});
