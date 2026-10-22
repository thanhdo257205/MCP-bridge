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
import { SOFT_TIMEOUT_FILE, isAbsoluteLimit, rampedWaitSeconds, readSoftTimeout, writeSoftTimeout } from '../src/soft-timeout.js';
import { writeWait } from '../src/wait-setting.js';

const token = 'test_token_123456789012345678901234567890';
const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('soft deadline setting: off by default, round trip, range, and anything unreadable means off',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-soft-'));
  assert.deepEqual(readSoftTimeout(dir),{enabled:false,limit_seconds:7200});
  await writeSoftTimeout(dir,{enabled:true,limit_seconds:3600});assert.deepEqual(readSoftTimeout(dir),{enabled:true,limit_seconds:3600});
  await writeSoftTimeout(dir,{enabled:false,limit_seconds:7200});assert.deepEqual(readSoftTimeout(dir),{enabled:false,limit_seconds:7200});
  await assert.rejects(writeSoftTimeout(dir,{enabled:true,limit_seconds:599}),/limit_seconds/);
  await assert.rejects(writeSoftTimeout(dir,{enabled:true,limit_seconds:28801}),/limit_seconds/);
  for(const bad of [599,28801,3600.5,'3600',null])assert.equal(isAbsoluteLimit(bad),false,String(bad));
  await writeFile(path.join(dir,SOFT_TIMEOUT_FILE),'{broken');assert.deepEqual(readSoftTimeout(dir),{enabled:false,limit_seconds:7200});
  await writeFile(path.join(dir,SOFT_TIMEOUT_FILE),JSON.stringify({enabled:'yes',limit_seconds:99999999}));assert.deepEqual(readSoftTimeout(dir),{enabled:false,limit_seconds:7200});
});
test('ramped waits: 1 minute, then 5, then the owner maximum, never above it',()=>{
  assert.deepEqual([0,1,2,3,9].map(n=>rampedWaitSeconds(n,600)),[60,300,600,600,600]);
  assert.deepEqual([0,1,2,3].map(n=>rampedWaitSeconds(n,900)),[60,300,900,900]);
  assert.deepEqual([0,1,2,3].map(n=>rampedWaitSeconds(n,55)),[55,55,55,55],'the default 55 s cap is not exceeded');
  assert.deepEqual([0,1,2].map(n=>rampedWaitSeconds(n,120)),[60,120,120]);
});

async function setup(options:{soft?:{enabled:boolean;limit_seconds:number}|null}={}){
  const root=await mkdtemp(path.join(tmpdir(),'agy-soft-run-'));const workspace=path.join(root,'work');await mkdir(workspace);const state=path.join(root,'state');
  await mkdir(state,{recursive:true});
  // Written directly so a test can use a limit below what the web UI allows.
  if(options.soft)await writeFile(path.join(state,SOFT_TIMEOUT_FILE),JSON.stringify(options.soft));
  const launched:string[][]=[];
  let scenario='active';let duration='2200';
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:state,deadlineGraceMs:0,softCheckDelaysMs:[400,400,400],
      launch:(args,cwd)=>{launched.push(args);const log=args[args.indexOf('--log-file')+1];return startProcess(process.execPath,[fixture,scenario,args.includes('--log-file')?log:'',duration],cwd);}});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},token,port:0});
  return {manager,bridge,workspace,state,launched,use:(name:string,ms='2200')=>{scenario=name;duration=ms;}};
}
const arg=(args:string[],flag:string)=>args[args.indexOf(flag)+1];

test('soft deadline on: a task that keeps writing its log is extended past the deadline and completes',async()=>{
  const {manager,bridge,workspace,launched}=await setup({soft:{enabled:true,limit_seconds:600}});
  try {
    const task=await manager.delegate({task:'slow but alive',workspace,acceptance_criteria:['x'],timeout_seconds:1});
    await manager.waitFor(task.task_id,15);
    const done=manager.get(task.task_id);
    assert.equal(done.status,'completed',JSON.stringify(done.error));
    assert.equal(arg(launched[0],'--print-timeout'),'600s','agy itself gets the absolute limit, so it does not stop at the first deadline');
    assert.match(arg(launched[0],'--log-file'),/agy-logs/);
    const activity=manager.detail(task.task_id).activity!;
    assert.ok(activity.soft_deadline&&activity.soft_deadline.extensions>=1,'extended at least once');
    assert.ok(activity.log_bytes!==null&&activity.log_bytes>0,'the log grew');assert.ok(activity.log_updated_at);
  } finally {await bridge.close();}
});
test('soft deadline on: a silent task is stopped at the deadline check, with the reason',async()=>{
  const {manager,bridge,workspace,use}=await setup({soft:{enabled:true,limit_seconds:600}});use('hang');
  try {
    const task=await manager.delegate({task:'silent',workspace,acceptance_criteria:['x'],timeout_seconds:1});
    await manager.waitFor(task.task_id,15);
    const done=manager.get(task.task_id);
    assert.equal(done.status,'timeout');assert.match(String(done.error),/No sign of activity/);
  } finally {await bridge.close();}
});
test('soft deadline on: the absolute limit still stops a task that is alive',async()=>{
  const {manager,bridge,workspace,use,state}=await setup({soft:null});use('active','8000');
  await writeFile(path.join(state,SOFT_TIMEOUT_FILE),JSON.stringify({enabled:true,limit_seconds:2}));
  try {
    const task=await manager.delegate({task:'too long',workspace,acceptance_criteria:['x'],timeout_seconds:1});
    await manager.waitFor(task.task_id,15);
    const done=manager.get(task.task_id);
    assert.equal(done.status,'timeout');assert.match(String(done.error),/absolute limit/);
  } finally {await bridge.close();}
});
test('soft deadline off (default): the old hard deadline applies and no log file is requested',async()=>{
  const {manager,bridge,workspace,launched}=await setup();
  try {
    const task=await manager.delegate({task:'hard deadline',workspace,acceptance_criteria:['x'],timeout_seconds:1});
    await manager.waitFor(task.task_id,15);
    assert.equal(manager.get(task.task_id).status,'timeout');
    assert.equal(arg(launched[0],'--print-timeout'),'1s');assert.ok(!launched[0].includes('--log-file'));
    assert.equal(manager.detail(task.task_id).activity!.soft_deadline,null);
  } finally {await bridge.close();}
});

test('ramped waits per task; an explicit length is honoured and does not advance the ramp',async()=>{
  const {manager,bridge,workspace,use,state}=await setup();use('hang');
  try {
    await writeWait(state,600);
    const task=await manager.delegate({task:'hang',workspace,acceptance_criteria:['x']});
    assert.deepEqual([manager.nextWaitSeconds(task.task_id),manager.nextWaitSeconds(task.task_id),manager.nextWaitSeconds(task.task_id),manager.nextWaitSeconds(task.task_id)],[60,300,600,600]);
    assert.equal(manager.nextWaitSeconds(task.task_id,30),30);assert.equal(manager.nextWaitSeconds(task.task_id,5000),600,'an explicit length is still capped');
    await writeWait(state,55);
    assert.equal(manager.nextWaitSeconds(task.task_id),55);
    const other=await manager.delegate({task:'queued?',workspace,acceptance_criteria:['x']}).catch(()=>null);
    assert.equal(other,null,'only one task runs at once (queue size 0 in this setup)');
    await manager.cancel(task.task_id);
  } finally {await bridge.close();}
});

test('wait and status on a running task carry a one-line activity note for the client',async()=>{
  const {manager,bridge,workspace,use,state}=await setup({soft:{enabled:true,limit_seconds:600}});use('active','4000');
  await writeWait(state,5);
  const client=new Client({name:'activity-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  try {
    const id=String(((await client.callTool({name:'antigravity_delegate',arguments:{task:'alive',workspace,acceptance_criteria:['x'],timeout_seconds:30}})).structuredContent as {task_id:string}).task_id);
    await new Promise(r=>setTimeout(r,600));
    const status=(await client.callTool({name:'antigravity_task_status',arguments:{task_id:id}})).structuredContent as {status:string;activity?:string;next_step?:string};
    assert.equal(status.status,'running');assert.match(String(status.activity),/last (log|output) activity \d+s ago/);assert.ok(status.next_step);
    const waited=(await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:20}})).structuredContent as {status:string;activity?:string};
    assert.equal(waited.status,'completed');assert.ok(!('activity' in waited),'no note once the task has ended');
    assert.equal(manager.activityNote(id),null);
  } finally {await client.close();await bridge.close();}
});

test('web UI: the owner switches the soft deadline; input is validated; the overview reports it',async()=>{
  const {bridge,state}=await setup();
  const api=(p:string,init:RequestInit={},session?:string)=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{}),...(session?{'X-Bridge-Session':session}:{})}});
  const session=String(((await (await api('login',{method:'POST',body:JSON.stringify({token})})).json()) as {session:string}).session);
  const set=(body:unknown,s:string|null=session)=>api('soft-timeout',{method:'POST',body:JSON.stringify(body)},s??undefined);
  try {
    assert.equal((await set({enabled:true},null)).status,401);
    for(const body of [{},{enabled:'yes'},{enabled:true,limit_seconds:599},{enabled:true,limit_seconds:28801},{enabled:true,limit_seconds:'3600'}])assert.equal((await set(body)).status,400,JSON.stringify(body));
    assert.deepEqual(await (await set({enabled:true,limit_seconds:3600})).json(),{enabled:true,limit_seconds:3600});
    assert.deepEqual(readSoftTimeout(state),{enabled:true,limit_seconds:3600});
    assert.deepEqual(((await (await api('overview',{},session)).json()) as {soft_timeout:unknown}).soft_timeout,{enabled:true,limit_seconds:3600});
    assert.deepEqual(await (await set({enabled:false})).json(),{enabled:false,limit_seconds:3600},'turning it off keeps the chosen limit');
  } finally {await bridge.close();}
});
