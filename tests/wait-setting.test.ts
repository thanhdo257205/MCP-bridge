import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { WAIT_FILE, clientToolTimeoutSeconds, isWaitSeconds, readWait, writeWait } from '../src/wait-setting.js';
import { WAITING_NOTE } from '../src/tools/register.js';
import { renderSetup, type SetupInput } from '../src/setup.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('wait setting: round trip, validation, and anything unreadable means "not set"',async()=>{
  assert.equal(isWaitSeconds(5),true);assert.equal(isWaitSeconds(3600),true);
  for(const bad of [4,3601,55.5,'55',null,undefined,NaN])assert.equal(isWaitSeconds(bad),false,String(bad));
  const dir=await mkdtemp(path.join(tmpdir(),'agy-wait-'));
  assert.equal(readWait(dir),null);
  await writeWait(dir,600);assert.equal(readWait(dir),600);
  await writeWait(dir,null);assert.equal(readWait(dir),null);
  await assert.rejects(writeWait(dir,4),/whole number/);
  await writeFile(path.join(dir,WAIT_FILE),JSON.stringify({seconds:99999}));assert.equal(readWait(dir),null);
  await writeFile(path.join(dir,WAIT_FILE),'{broken');assert.equal(readWait(dir),null);
  assert.equal(clientToolTimeoutSeconds(55),115);assert.equal(clientToolTimeoutSeconds(600),660);assert.equal(clientToolTimeoutSeconds(5),65);
});

test('setup prints a Codex tool timeout that follows the wait length',()=>{
  const base:SetupInput={clients:['codex'],mcpUrl:'http://127.0.0.1:3000/mcp',shells:['bash'],bin:'agy-mcp-bridge'};
  assert.match(renderSetup(base),/tool_timeout_sec = 115/);
  assert.match(renderSetup({...base,waitSeconds:600}),/tool_timeout_sec = 660/);
});

async function setup(scenario:string,configWait?:number){
  const root=await mkdtemp(path.join(tmpdir(),'agy-wait-ui-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv',...(configWait===undefined?{}:{max_wait_seconds:configWait})},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(_a,cwd)=>startProcess(process.execPath,[fixture,scenario],cwd)});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  const api=(p:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{})}});
  return {manager,bridge,api,workspace,root};
}

test('web UI: the owner sets the wait length; it beats the config file, is validated, and reaches the environment',async()=>{
  const {manager,bridge,api}=await setup('ok',120);
  const set=(body:unknown)=>api('wait',{method:'POST',body:JSON.stringify(body)});
  try {
    assert.equal(manager.maxWaitSeconds,120,'config value when nothing is chosen');
    for(const seconds of [4,3601,12.5,'60',undefined])assert.equal((await set({seconds})).status,400,String(seconds));
    const done=await (await set({seconds:600})).json() as {seconds:number;client_tool_timeout_seconds:number};
    assert.equal(done.seconds,600);assert.equal(done.client_tool_timeout_seconds,660);assert.equal(manager.maxWaitSeconds,600);
    assert.equal(manager.overview().max_wait_seconds,600,'reported to the client through antigravity_environment');
    const overview=await (await api('overview')).json() as {wait:{seconds:number;client_tool_timeout_seconds:number}};
    assert.deepEqual(overview.wait,{seconds:600,client_tool_timeout_seconds:660});
    assert.equal((await set({seconds:null})).status,200);assert.equal(manager.maxWaitSeconds,120,'back to the config value');
  } finally {await bridge.close();}
});

test('a wait or status call on a running task tells the client to do nothing else; a finished task does not',async()=>{
  const {manager,bridge,workspace,root}=await setup('hang');
  await writeWait(path.join(root,'state'),5);
  const client=new Client({name:'wait-note-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)));
  try {
    const id=String(((await client.callTool({name:'antigravity_delegate',arguments:{task:'hang',workspace,acceptance_criteria:['x']}})).structuredContent as {task_id:string}).task_id);
    const status=(await client.callTool({name:'antigravity_task_status',arguments:{task_id:id}})).structuredContent as {status:string;next_step?:string};
    assert.equal(status.status,'running');assert.equal(status.next_step,WAITING_NOTE);
    const waited=(await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:5}})).structuredContent as {status:string;next_step?:string};
    assert.equal(waited.status,'running');assert.equal(waited.next_step,WAITING_NOTE);
    assert.match(WAITING_NOTE,/Do nothing else/);assert.match(WAITING_NOTE,/antigravity_task_wait again/);
    await manager.cancel(id);
    const finished=(await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:5}})).structuredContent as {status:string;next_step?:string};
    assert.equal(finished.status,'canceled');assert.ok(!('next_step' in finished),'no instruction once the task has ended');
  } finally {await client.close();await bridge.close();}
});
