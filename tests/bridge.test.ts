import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { validateWorkspace, inside } from '../src/security/workspace.js';
import { isAlive, waitUntilDead } from './helpers.js';
import { delegateSchema } from '../src/security/input.js';
import type { Config } from '../src/config.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs', import.meta.url));
async function setup(scenario = 'ok', overrides: Partial<Config> = {}) {
  const root = await mkdtemp(path.join(tmpdir(),'agy-bridge-test-'));
  const workspace = path.join(root,'work'); await mkdir(workspace);
  const config: Config = {allowed_workspaces:[workspace], executable:process.execPath,max_timeout_seconds:5,default_timeout_seconds:3,max_output_bytes:1024,max_retained_tasks:3,...overrides};
  const manager = new TaskManager(config,{executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(_args,cwd)=>startProcess(process.execPath,[fixture,scenario],cwd)});
  const input = {task:'Implement safe task',workspace,acceptance_criteria:['Verified']};
  return {root,workspace,config,manager,input};
}

test('strict validation rejects missing fields, empty criteria, flags and oversized timeout',()=>{
  for (const item of [{}, {task:'x',workspace:'x',acceptance_criteria:[]},{task:'x',workspace:'x',acceptance_criteria:['ok'],timeout_seconds:901},{task:'x',workspace:'x',acceptance_criteria:['ok'],shell:true}]) assert.equal(delegateSchema.safeParse(item).success,false);
  assert.equal(delegateSchema.safeParse({task:'x\0',workspace:'x',acceptance_criteria:['ok']}).success,false);
  assert.equal(delegateSchema.safeParse({task:'x'.repeat(16000),workspace:'x',context:'x'.repeat(12000),acceptance_criteria:['ok']}).success,false);
});
test('workspace boundary, traversal, sibling prefix and junction checks',async()=>{
  const {root,workspace}=await setup(); const outside=path.join(root,'work-escape');await mkdir(outside);
  assert.equal(inside(workspace,outside),false);
  assert.equal(await validateWorkspace(workspace,[workspace]),await validateWorkspace(workspace,[root]));
  await assert.rejects(validateWorkspace('relative',[workspace]));
  await assert.rejects(validateWorkspace(path.join(workspace,'..','work-escape'),[workspace]));
  await assert.rejects(validateWorkspace(workspace,[]));
  const link=path.join(workspace,'escape');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(validateWorkspace(workspace,[workspace]),/symlink|junction/);
  await assert.rejects(validateWorkspace(link,[root]),/symlink|junction/);
});
test('mock lifecycle, bounded retention and immutable snapshots',async()=>{
  const {manager,input}=await setup();
  let first = '';
  for(let i=0;i<4;i++) {
    const started=await manager.delegate(input);assert.equal(started.status,'running');
    const done=await manager.wait(started.task_id);assert.equal(done.status,'completed');assert.equal(done.final_response,'implemented');assert.equal(done.exit_code,0);assert.equal(done.acceptance_verified,false);assert.ok(done.ended_at);
    done.stdout='modified';assert.notEqual(manager.get(done.task_id).stdout,'modified');
    if(i===0) first=done.task_id;
  }
  assert.throws(()=>manager.get(first),/Unknown/);
});
for (const [scenario,status] of [['fail','failed'],['malformed','failed'],['partial','timeout'],['empty','failed'],['denied','failed'],['large','failed'],['secret','completed']] as const) {
  test(`mock ${scenario} yields ${status}`,async()=>{
    const {manager,input}=await setup(scenario);const task=await manager.delegate(input);const done=await manager.wait(task.task_id);
    assert.equal(done.status,status);
    if(scenario==='fail') {assert.equal(done.exit_code,7);assert.equal(done.error,'deliberate failure');}
    if(scenario==='large') {assert.equal(done.stdout_truncated,true);assert.ok(Buffer.byteLength(done.stdout)<=1024);assert.ok(done.stdout_bytes>1024);}
    if(scenario==='secret') {assert.ok(!done.stdout.includes('supersecret'));assert.ok(!done.final_response?.includes('abc.def.ghi'));}
    if(scenario==='denied') assert.equal(done.denied_actions[0].action,'write_file');
  });
}
test('timeout kills hanging mock and frees execution lock',async()=>{
  const {manager,input,root}=await setup('hang');const task=await manager.delegate({...input,timeout_seconds:1});
  assert.equal((await manager.wait(task.task_id)).status,'timeout');
  assert.equal((await readdir(path.join(root,'state'))).includes('execution.lock'),false);
});
test('cancel kills only managed process tree and leaves unrelated process alive',async()=>{
  const {manager,input}=await setup('tree');
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  try {
    const task=await manager.delegate(input);
    const deadline=Date.now()+3000;
    while(!manager.get(task.task_id).stderr && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    const descendant=Number(manager.get(task.task_id).stderr);assert.ok(descendant>0);
    const done=await manager.cancel(task.task_id);assert.equal(done.status,'canceled');assert.equal(done.process_running,false);
    assert.equal(await waitUntilDead(descendant),true);assert.equal(isAlive(unrelated.pid!),true);
    assert.equal((await manager.cancel(task.task_id)).status,'canceled');
    await assert.rejects(manager.cancel('unknown'),/Unknown/);
  } finally { unrelated.kill(); await manager.shutdown(); }
});
test('concurrent delegates, overlapping workspaces and second server are locked',async()=>{
  const {manager,input,config,root}=await setup('hang');
  const second=new TaskManager(config,{executable:process.execPath,supported:true,stateDirectory:path.join(root,'state')});
  const one=manager.delegate(input);await assert.rejects(manager.delegate(input),/busy/);const task=await one;
  await assert.rejects(second.delegate(input),/lock/);
  await manager.shutdown();assert.equal(manager.get(task.task_id).status,'canceled');
  await assert.rejects(manager.delegate(input),/shutting down/);
});
test('unsupported runtime never launches and configured timeout is enforced',async()=>{
  const {config,root,input}=await setup();
  const manager=new TaskManager(config,{executable:'missing',supported:false,stateDirectory:root,launch:()=>{throw new Error('must not launch')}});
  assert.equal((await manager.delegate(input)).status,'unsupported');
  await assert.rejects(manager.delegate({...input,timeout_seconds:6}),/maximum/);
});
test('missing executable reports spawn failure and releases lock',async()=>{
  const {config,root,input}=await setup();const manager=new TaskManager(config,{executable:path.join(root,'missing.exe'),supported:true,stateDirectory:root});
  const task=await manager.delegate(input);const done=await manager.wait(task.task_id);assert.equal(done.status,'failed');assert.ok(done.error);
});
test('real stdio entry emits only JSON-RPC on stdout and diagnostics on stderr',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agy-protocol-'));const configPath=path.join(root,'config.json');
  await writeFile(configPath,JSON.stringify({allowed_workspaces:[],executable:path.join(root,'missing.exe')}));
  const child=spawn(process.execPath,['dist/src/stdio.js'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,ANTIGRAVITY_BRIDGE_CONFIG:configPath},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  const messages:Record<string,unknown>[]=[];let invalid=false;
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{messages.push(JSON.parse(line))}catch{invalid=true}});
  const waitFor=async(id:number)=>{
    const limit=Date.now()+5000;while(!messages.find(m=>m.id===id) && Date.now()<limit) await new Promise(r=>setTimeout(r,10));
    const m=messages.find(m=>m.id===id);assert.ok(m,`missing reply ${id}; ${stderr}`);return m;
  };
  const send=(value:object)=>child.stdin.write(JSON.stringify(value)+'\n');
  try {
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});await waitFor(1);
    send({jsonrpc:'2.0',method:'notifications/initialized'});
    send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});const list=await waitFor(2);assert.equal((list.result as {tools:unknown[]}).tools.length,6);
    send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'antigravity_environment',arguments:{}}});const env=await waitFor(3);
    assert.match(JSON.stringify(env),/unsupported/);
    assert.equal(invalid,false);assert.ok(messages.every(m=>m.jsonrpc==='2.0'));assert.match(stderr,/stdio ready/);
  } finally {child.stdin.end();await new Promise<void>(r=>child.once('close',()=>r()));lines.close();}
});
test('summary omits logs and waitFor returns early or after its deadline',async()=>{
  const {manager,input}=await setup('delayed');
  const started=await manager.delegate(input);
  const pending=await manager.waitFor(started.task_id,0.05);assert.equal(pending.status,'running');
  const summary=manager.summary(started.task_id) as Record<string,unknown>;
  for(const key of ['stdout','stderr','final_response']) assert.ok(!(key in summary));
  assert.equal(summary.status,'running');
  const done=await manager.waitFor(started.task_id,5);assert.equal(done.status,'completed');
  await assert.rejects(manager.waitFor('unknown',1),/Unknown/);
});
test('finished tasks survive a restart; a task running during a crash is marked failed',async()=>{
  const {manager,input,config,root,workspace}=await setup();
  const done=await manager.wait((await manager.delegate(input)).task_id);assert.equal(done.status,'completed');
  const state=path.join(root,'state');
  const crashed={...done,task_id:'11111111-1111-4111-8111-111111111111',status:'running',process_running:true,ended_at:null};
  await writeFile(path.join(state,'tasks',`${crashed.task_id}.json`),JSON.stringify(crashed));
  await writeFile(path.join(state,'tasks','not-a-task.json'),'{}');
  const reloaded=new TaskManager(config,{executable:process.execPath,supported:true,stateDirectory:state});
  assert.equal(await reloaded.restore(),2);
  assert.equal(reloaded.get(done.task_id).final_response,'implemented');
  const lost=reloaded.get(crashed.task_id);assert.equal(lost.status,'failed');assert.equal(lost.process_running,false);assert.match(String(lost.error),/restarted/);
  assert.equal(workspace.length>0,true);
});
test('evicted tasks lose their persisted record',async()=>{
  const {manager,input,root}=await setup();
  const ids:string[]=[];
  for(let i=0;i<4;i++) ids.push((await manager.wait((await manager.delegate(input)).task_id)).task_id);
  const files=await readdir(path.join(root,'state','tasks'));
  assert.equal(files.length,3);assert.ok(!files.includes(`${ids[0]}.json`));
});
test('stale execution lock is diagnosed but never removed',async()=>{
  const {manager,input,root}=await setup();
  const state=path.join(root,'state');await mkdir(path.join(state,'execution.lock'),{recursive:true});
  await writeFile(path.join(state,'owner.json'),JSON.stringify({server_pid:2147483646,started_at:'2020-01-01T00:00:00Z'}));
  await assert.rejects(manager.delegate(input),/may be stale.*remove the directory/);
  assert.ok((await readdir(state)).includes('execution.lock'));
});
test('delegation kill switch: env, invalid value and switch file refuse new tasks but keep existing ones usable',async()=>{
  const {manager,input,root}=await setup('hang');
  const state=path.join(root,'state');
  const saved=process.env.BRIDGE_DELEGATION;
  try {
    const running=await manager.delegate(input);
    process.env.BRIDGE_DELEGATION='off';
    assert.equal((manager.overview().delegation as {enabled:boolean}).enabled,false);
    await assert.rejects(manager.delegate(input),/disabled by the bridge owner.*BRIDGE_DELEGATION=off/);
    assert.equal(manager.get(running.task_id).status,'running');
    process.env.BRIDGE_DELEGATION='maybe';
    await assert.rejects(manager.delegate(input),/invalid value/);
    delete process.env.BRIDGE_DELEGATION;
    await writeFile(path.join(state,'delegation.off'),'x');
    await assert.rejects(manager.delegate(input),/npm run delegation/);
    assert.equal((await manager.cancel(running.task_id)).status,'canceled');
    await rm(path.join(state,'delegation.off'));
    assert.deepEqual(manager.overview().delegation,{enabled:true,reason:null});
    const again=await manager.delegate(input);assert.equal(again.status,'running');
  } finally {
    if(saved===undefined) delete process.env.BRIDGE_DELEGATION; else process.env.BRIDGE_DELEGATION=saved;
    await manager.shutdown();
  }
});
