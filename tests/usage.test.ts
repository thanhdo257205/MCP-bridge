import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { USAGE_FILE, appendUsage, extractStats, flattenNumbers, readUsage, summarizeUsage, type UsageRecord } from '../src/usage.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));
const record=(over:Partial<UsageRecord>={}):UsageRecord=>({at:'2026-10-22T05:00:00.000Z',status:'completed',model:null,effort:null,permission:'default',duration_ms:1000,agy_duration_seconds:null,num_turns:1,steps:null,usage:null,...over});

test('flattenNumbers keeps numeric leaves under dotted names and nothing else',()=>{
  assert.deepEqual(flattenNumbers({input_tokens:10,output_tokens:2,cache:{read:5,write:1},text:'x',list:[1,2],nope:null,bad:Number.NaN,inf:Infinity}),{input_tokens:10,output_tokens:2,'cache.read':5,'cache.write':1});
  assert.deepEqual(flattenNumbers(undefined),{});assert.deepEqual(flattenNumbers('x'),{});assert.deepEqual(flattenNumbers([1,2]),{});
  assert.deepEqual(flattenNumbers({a:{b:{c:{d:1}}}}),{},'at most three levels');assert.deepEqual(flattenNumbers({a:{b:{c:1}}}),{'a.b.c':1});
  assert.deepEqual(flattenNumbers({'bad key!':1,ok:2}),{ok:2},'names are restricted to safe characters');
  const many=Object.fromEntries(Array.from({length:100},(_,i)=>[`k${i}`,i]));assert.equal(Object.keys(flattenNumbers(many)).length,40);
});
test('extractStats: every part is optional and only sane numbers are taken',()=>{
  assert.deepEqual(extractStats({status:'SUCCESS'},null),{usage:null,agy_duration_seconds:null,num_turns:null,steps:null});
  assert.deepEqual(extractStats({usage:{input_tokens:3},duration_seconds:2.5,num_turns:4},7),{usage:{input_tokens:3},agy_duration_seconds:2.5,num_turns:4,steps:7});
  assert.deepEqual(extractStats({usage:{},duration_seconds:-1,num_turns:'3'},null),{usage:null,agy_duration_seconds:null,num_turns:null,steps:null});
});
test('summarizeUsage: totals, groups, and the viewer\'s local days (with empty days present)',()=>{
  const now=Date.parse('2026-10-22T10:00:00Z');
  const records=[
    record({at:'2026-10-21T20:00:00.000Z',model:'claude-sonnet-4-6',effort:'low',usage:{input_tokens:100,output_tokens:10},duration_ms:2000,num_turns:2}),
    record({at:'2026-10-22T03:00:00.000Z',status:'failed',model:'claude-sonnet-4-6',usage:{input_tokens:50},duration_ms:500,steps:4,agy_duration_seconds:1.5}),
    record({at:'2026-10-20T01:00:00.000Z',model:null,duration_ms:300})
  ];
  const utc=summarizeUsage(records,{now,tzOffsetMinutes:0,days:4});
  assert.equal(utc.totals.tasks,3);assert.equal(utc.totals.completed,2);assert.deepEqual(utc.totals.by_status,{completed:2,failed:1});
  assert.equal(utc.totals.duration_ms,2800);assert.equal(utc.totals.turns,4);assert.equal(utc.totals.steps,4);assert.equal(utc.totals.agy_duration_seconds,1.5);assert.equal(utc.totals.with_usage,2);
  assert.deepEqual(utc.totals.usage,{input_tokens:150,output_tokens:10});
  assert.equal(utc.since,'2026-10-21T20:00:00.000Z');
  assert.deepEqual(utc.by_day.map(d=>d.day),['2026-10-19','2026-10-20','2026-10-21','2026-10-22']);assert.deepEqual(utc.by_day.map(d=>d.tasks),[0,1,1,1]);
  // UTC+7 (the browser reports -420): the 20:00Z task is already 03:00 the next morning.
  const vn=summarizeUsage(records,{now,tzOffsetMinutes:-420,days:4});assert.deepEqual(vn.by_day.map(d=>d.tasks),[0,1,0,2]);
  assert.deepEqual(utc.by_model.map(g=>[g.key,g.tasks]),[['claude-sonnet-4-6',2],['default',1]]);assert.deepEqual(utc.by_model[0].usage,{input_tokens:150,output_tokens:10});
  assert.deepEqual(utc.by_effort.map(g=>[g.key,g.tasks]).sort(),[['default',2],['low',1]]);
  assert.equal(utc.recent[0].at,'2026-10-20T01:00:00.000Z','the latest appended record comes first');
  assert.deepEqual(summarizeUsage([],{now}).totals.tasks,0);assert.equal(summarizeUsage([],{now}).since,null);
});
test('usage ledger: round trip, damaged lines skipped, and it is trimmed when it grows large',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-usage-'));
  assert.deepEqual(await readUsage(dir),[]);
  await appendUsage(dir,record({usage:{input_tokens:1}}));await appendUsage(dir,record({status:'timeout'}));
  await writeFile(path.join(dir,USAGE_FILE),(await readFile(path.join(dir,USAGE_FILE),'utf8'))+'{broken\n{"at":"nope"}\n');
  const read=await readUsage(dir);assert.equal(read.length,2);assert.deepEqual(read[0].usage,{input_tokens:1});assert.equal(read[1].status,'timeout');
  const line=JSON.stringify(record({usage:{input_tokens:12345,output_tokens:678}}));
  await writeFile(path.join(dir,USAGE_FILE),Array.from({length:6000},()=>line).join('\n')+'\n');
  await appendUsage(dir,record({status:'failed'}));
  const trimmed=await readUsage(dir);assert.equal(trimmed.length,3000);assert.equal(trimmed.at(-1)!.status,'failed','the newest record survives the trim');
});

async function setup(){
  const root=await mkdtemp(path.join(tmpdir(),'agy-usage-run-'));const workspace=path.join(root,'work');await mkdir(workspace);const state=path.join(root,'state');
  let scenario='usage';
  const config={allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv' as const};
  const runtime={executable:process.execPath,supported:true,stateDirectory:state,launch:(_a:string[],cwd:string)=>startProcess(process.execPath,[fixture,scenario],cwd)};
  const manager=new TaskManager(config,runtime);
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  return {manager,bridge,workspace,state,config,runtime,use:(name:string)=>{scenario=name;}};
}
const run=async(manager:TaskManager,workspace:string)=>{const task=await manager.delegate({task:'t',workspace,acceptance_criteria:['x']});await manager.waitFor(task.task_id,15);return task.task_id;};

test('a finished task keeps what agy reported about its cost, in the ledger and in the task record across a restart',async()=>{
  const {manager,bridge,workspace,state,config,runtime}=await setup();
  try {
    const id=await run(manager,workspace);
    assert.equal(manager.get(id).status,'completed');
    assert.deepEqual(manager.detail(id).stats,{usage:{input_tokens:1200,output_tokens:80,'cache.read_tokens':5},agy_duration_seconds:3.25,num_turns:2,steps:null});
    const ledger=await readUsage(state);assert.equal(ledger.length,1);
    assert.deepEqual([ledger[0].status,ledger[0].model,ledger[0].effort,ledger[0].permission,ledger[0].num_turns],['completed',null,'default','default',2]);
    assert.deepEqual(ledger[0].usage,{input_tokens:1200,output_tokens:80,'cache.read_tokens':5});assert.ok(ledger[0].duration_ms>=0);
    const again=new TaskManager(config,runtime);await again.restore();
    assert.deepEqual(again.detail(id).stats?.usage,{input_tokens:1200,output_tokens:80,'cache.read_tokens':5});
  } finally {await bridge.close();}
});
test('a result without usage is recorded as such, not as zeros',async()=>{
  const {manager,bridge,workspace,state,use}=await setup();use('ok');
  try {
    const id=await run(manager,workspace);
    assert.equal(manager.detail(id).stats?.usage,null);
    const ledger=await readUsage(state);assert.equal(ledger[0].usage,null);assert.equal(summarizeUsage(ledger).totals.with_usage,0);
  } finally {await bridge.close();}
});
test('web UI: the usage endpoint sums the ledger and tolerates a bad time zone',async()=>{
  const {manager,bridge,workspace}=await setup();
  const api=(p:string)=>fetch(`${bridge.baseUrl}/ui/api/${p}`);
  try {
    await run(manager,workspace);await run(manager,workspace);
    const summary=await (await api('usage?tz=-420')).json() as {totals:{tasks:number;usage:Record<string,number>;with_usage:number};by_day:unknown[]};
    assert.equal(summary.totals.tasks,2);assert.equal(summary.totals.with_usage,2);assert.equal(summary.totals.usage.input_tokens,2400);assert.equal(summary.by_day.length,14);
    for(const tz of ['abc','99999','1.5'])assert.equal((await api(`usage?tz=${tz}`)).status,200,`bad tz ${tz} is ignored`);
  } finally {await bridge.close();}
});
