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
import { EFFORT_FILE, EFFORT_LEVELS, effortFlags, readEffort, writeEffort } from '../src/effort.js';
import { DEFAULT_MAX_WAIT_SECONDS } from '../src/security/input.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('effort: flags, default, round trip, and anything unknown means no flag',async()=>{
  assert.deepEqual([...EFFORT_LEVELS],['default','low','medium','high','xhigh','max']);
  assert.deepEqual(effortFlags('default'),[]);assert.deepEqual(effortFlags('low'),['--effort','low']);assert.deepEqual(effortFlags('max'),['--effort','max']);
  const dir=await mkdtemp(path.join(tmpdir(),'agy-effort-'));
  assert.equal(readEffort(dir),'default');
  await writeEffort(dir,'low');assert.equal(readEffort(dir),'low');
  await writeEffort(dir,'default');assert.equal(readEffort(dir),'default');
  await writeFile(path.join(dir,EFFORT_FILE),JSON.stringify({effort:'--evil'}));assert.equal(readEffort(dir),'default');
  await writeFile(path.join(dir,EFFORT_FILE),'{broken');assert.equal(readEffort(dir),'default');
});

async function setup(scenario:string,maxWait?:number){
  const root=await mkdtemp(path.join(tmpdir(),'agy-effort-ui-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const launched:string[][]=[];
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv',...(maxWait===undefined?{}:{max_wait_seconds:maxWait})},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(args,cwd)=>{launched.push(args);return startProcess(process.execPath,[fixture,scenario],cwd);}});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  const api=(p:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{})}});
  return {manager,bridge,api,workspace,launched};
}

test('web UI: effort is set by the owner, validated, applied to new tasks and recorded on them',async()=>{
  const {manager,bridge,api,workspace,launched}=await setup('ok');
  const set=(body:unknown)=>api('effort',{method:'POST',body:JSON.stringify(body)});
  try {
    for(const effort of ['turbo','',42,undefined,null])assert.equal((await set({effort})).status,400,String(effort));
    const before=await manager.delegate({task:'t1',workspace,acceptance_criteria:['x']});await manager.waitFor(before.task_id,10);
    assert.ok(!launched[0].includes('--effort'));assert.equal(manager.detail(before.task_id).request?.effort,'default');
    assert.equal((await set({effort:'low'})).status,200);
    assert.equal(((await (await api('overview')).json()) as {effort:string}).effort,'low');
    const after=await manager.delegate({task:'t2',workspace,acceptance_criteria:['x']});await manager.waitFor(after.task_id,10);
    assert.equal(launched[1][launched[1].indexOf('--effort')+1],'low');assert.equal(manager.detail(after.task_id).request?.effort,'low');
    assert.equal(manager.detail(before.task_id).request?.effort,'default','earlier tasks keep what they ran with');
    assert.equal((await set({effort:'default'})).status,200);
    assert.equal(((await (await api('overview')).json()) as {effort:string}).effort,'default');
  } finally {await bridge.close();}
});

async function connect(url:string){
  const client=new Client({name:'wait-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));return client;
}
test('task_wait: the cap comes from max_wait_seconds, a bare call waits the cap, and it is advertised',async()=>{
  const {manager,bridge,workspace}=await setup('hang',1);const client=await connect(bridge.mcpUrl);
  try {
    assert.equal(manager.maxWaitSeconds,1);
    const tools=(await client.listTools()).tools;const wait=tools.find(tool=>tool.name==='antigravity_task_wait')!;
    assert.match(String(wait.description),/1-1, default 1/);
    const id=String(((await client.callTool({name:'antigravity_delegate',arguments:{task:'hang',workspace,acceptance_criteria:['x']}})).structuredContent as {task_id:string}).task_id);
    for(const args of [{task_id:id},{task_id:id,wait_seconds:30}]){
      const started=Date.now();
      const result=await client.callTool({name:'antigravity_task_wait',arguments:args});
      assert.ok(!result.isError,JSON.stringify(result));assert.equal((result.structuredContent as {status:string}).status,'running');
      const elapsed=Date.now()-started;assert.ok(elapsed>=900&&elapsed<5000,`waited ${elapsed}ms, expected about the 1s cap`);
    }
    await manager.cancel(id);
  } finally {await client.close();await bridge.close();}
});
test('task_wait: the default cap sits below the 60s client tool timeout',async()=>{
  const {manager,bridge}=await setup('hang');
  try { assert.equal(manager.maxWaitSeconds,DEFAULT_MAX_WAIT_SECONDS);assert.ok(DEFAULT_MAX_WAIT_SECONDS<60); } finally {await bridge.close();}
});
