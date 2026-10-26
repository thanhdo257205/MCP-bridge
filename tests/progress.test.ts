import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { invocationFor } from '../src/antigravity/invocation.js';
import { PROGRESS_FILE, rawStep, readProgress, summarizeStep, writeProgress } from '../src/progress.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('summarizeStep picks descriptive fields, looks one level down, redacts, shortens and never throws',()=>{
  assert.equal(summarizeStep({type:'read_file',status:'running',path:'src/a.ts',extra:1}),'read_file · running · src/a.ts');
  assert.equal(summarizeStep('plain   string\nstep'),'plain string step');
  assert.equal(summarizeStep({detail:{title:'Edit file',status:'done'}}),'Edit file · done');
  assert.equal(summarizeStep({alpha:1,beta:{gamma:[1,2]}}),'{alpha, beta}','unknown shape: field names only');
  assert.equal(summarizeStep({}),'(empty step)');assert.equal(summarizeStep(null),'(empty step)');assert.equal(summarizeStep(undefined),'(empty step)');
  assert.ok(summarizeStep({message:'x'.repeat(1000)}).length<=200);
  assert.ok(!summarizeStep({message:'Bearer abc.def.ghi'}).includes('abc.def.ghi'));
  assert.ok(!rawStep({note:'Bearer abc.def.ghi'}).includes('abc.def.ghi'));assert.ok(rawStep({a:'y'.repeat(2000)}).length<=600);
  const circular:Record<string,unknown>={};circular.self=circular;assert.equal(rawStep(circular),'');
});
test('progress setting: off by default, round trip, unreadable means off',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-progress-'));
  assert.deepEqual(readProgress(dir),{enabled:false});
  await writeProgress(dir,true);assert.deepEqual(readProgress(dir),{enabled:true});
  await writeProgress(dir,false);assert.deepEqual(readProgress(dir),{enabled:false});
  await writeFile(path.join(dir,PROGRESS_FILE),'{broken');assert.deepEqual(readProgress(dir),{enabled:false});
  await writeFile(path.join(dir,PROGRESS_FILE),JSON.stringify({enabled:'yes'}));assert.deepEqual(readProgress(dir),{enabled:false});
});
test('argv-stream: the prompt stays on the command line and only the output becomes stream-json',()=>{
  const stream=invocationFor('do it',30,'argv-stream','m',['--effort','low']);
  assert.deepEqual(stream.args.slice(0,4),['--print','do it','--output-format','stream-json']);assert.ok(!stream.args.includes('--input-format'));assert.equal(stream.stdin,undefined);
  assert.ok(stream.args.includes('--model')&&stream.args.includes('--effort'));
  const json=invocationFor('do it',30,'argv');assert.deepEqual(json.args.slice(0,4),['--print','do it','--output-format','json']);
});

async function setup(){
  const root=await mkdtemp(path.join(tmpdir(),'agy-progress-run-'));const workspace=path.join(root,'work');await mkdir(workspace);const state=path.join(root,'state');await mkdir(state,{recursive:true});
  const launched:string[][]=[];let scenario='ok';
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:state,launch:(args,cwd)=>{launched.push(args);return startProcess(process.execPath,[fixture,scenario],cwd);}});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  return {manager,bridge,workspace,state,launched,use:(name:string)=>{scenario=name;}};
}
const run=async(manager:TaskManager,workspace:string)=>{const task=await manager.delegate({task:'t',workspace,acceptance_criteria:['x']});await manager.waitFor(task.task_id,15);return task.task_id;};

test('step progress on: steps are recorded and shown, the result is read, step lines stay out of the log',async()=>{
  const {manager,bridge,workspace,state,launched,use}=await setup();use('stream');await writeProgress(state,true);
  try {
    const id=await run(manager,workspace);
    const done=manager.get(id);
    assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.final_response,'stream done');
    assert.equal(launched[0][launched[0].indexOf('--output-format')+1],'stream-json');assert.ok(!launched[0].includes('--input-format'));
    assert.match(done.stdout,/"event":"init"/);assert.doesNotMatch(done.stdout,/step_update/,'steps are not kept in the log');
    const steps=manager.detail(id).activity!.steps!;
    assert.equal(steps.total,3);
    assert.deepEqual(steps.recent.map(step=>step.summary),['read_file · running · src/a.ts','think · đọc cấu hình ệ xong','plain string step']);
    assert.ok(steps.recent.every(step=>!step.raw.includes('abc.def.ghi')),'raw data is redacted');
  } finally {await bridge.close();}
});
test('step progress on: thousands of steps do not hit the output cap and the task still completes',async()=>{
  const {manager,bridge,workspace,state,use}=await setup();use('stream-many');await writeProgress(state,true);
  try {
    const id=await run(manager,workspace);
    const done=manager.get(id);
    assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.stdout_truncated,false);assert.ok(done.stdout_bytes>500000,'well over the 4096-byte cap in total');
    const steps=manager.detail(id).activity!.steps!;
    assert.ok(steps.total>=3000);assert.equal(steps.recent.length,100,'only the latest are kept');assert.equal(steps.recent.at(-1)!.n,steps.total);
  } finally {await bridge.close();}
});
test('step progress on: an unexpected result is reported with its field names, and how to go back',async()=>{
  const {manager,bridge,workspace,state,use}=await setup();use('stream-bad');await writeProgress(state,true);
  try {
    const id=await run(manager,workspace);
    const done=manager.get(id);
    assert.equal(done.status,'failed');assert.match(String(done.error),/stream result fields: something/);assert.match(String(done.error),/turn it off/);
  } finally {await bridge.close();}
});
test('step progress off (default): the verified JSON mode is used and no steps exist',async()=>{
  const {manager,bridge,workspace,launched,use}=await setup();use('ok');
  try {
    const id=await run(manager,workspace);
    assert.equal(manager.get(id).status,'completed');assert.equal(launched[0][launched[0].indexOf('--output-format')+1],'json');
    assert.equal(manager.detail(id).activity!.steps,null);
  } finally {await bridge.close();}
});
test('a running task with steps tells the client how many were reported, and the signal counts as activity',async()=>{
  const {manager,bridge,workspace,state,use}=await setup();use('stream-hang');await writeProgress(state,true);
  try {
    const task=await manager.delegate({task:'t',workspace,acceptance_criteria:['x']});
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.match(String(manager.activityNote(task.task_id)),/\d+ steps reported/);
    assert.match(String(manager.activityNote(task.task_id)),/last output activity \d+s ago/);
    await manager.cancel(task.task_id);
  } finally {await bridge.close();}
});
test('web UI: the owner switches step progress; input is validated; the overview reports it',async()=>{
  const {bridge,state}=await setup();
  const api=(p:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{})}});
  const set=(body:unknown)=>api('progress',{method:'POST',body:JSON.stringify(body)});
  try {
    for(const body of [{},{enabled:'yes'},{enabled:1}])assert.equal((await set(body)).status,400,JSON.stringify(body));
    assert.deepEqual(await (await set({enabled:true})).json(),{enabled:true});assert.deepEqual(readProgress(state),{enabled:true});
    assert.deepEqual(((await (await api('overview')).json()) as {progress:unknown}).progress,{enabled:true});
    assert.deepEqual(await (await set({enabled:false})).json(),{enabled:false});
  } finally {await bridge.close();}
});
