import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { BUDGET_FILE, budgetState, isBudgetTokens, readBudget, tokensToday, writeBudget } from '../src/budget.js';
import { USAGE_FILE, totalTokens, type UsageRecord } from '../src/usage.js';
import { missionsFor } from './helpers.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));
const record=(over:Partial<UsageRecord>={}):UsageRecord=>({at:'2026-10-22T05:00:00.000Z',status:'completed',model:null,effort:null,permission:'default',duration_ms:1000,agy_duration_seconds:null,num_turns:1,steps:null,usage:null,...over});

test('totalTokens: agy\'s own total, else input plus output, else nothing',()=>{
  assert.equal(totalTokens({input_tokens:15072,output_tokens:1,total_tokens:15073}),15073);
  assert.equal(totalTokens({input_tokens:100,output_tokens:20}),120);assert.equal(totalTokens({input_tokens:100}),100);
  assert.equal(totalTokens({thinking_tokens:5}),null);assert.equal(totalTokens(null),null);assert.equal(totalTokens(undefined),null);
});
test('budget setting: no limit by default, round trip, range, and anything unreadable means no limit',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-budget-'));
  assert.deepEqual(readBudget(dir),{task_tokens:null,day_tokens:null});
  await writeBudget(dir,{task_tokens:100000,day_tokens:null});assert.deepEqual(readBudget(dir),{task_tokens:100000,day_tokens:null});
  await writeBudget(dir,{task_tokens:null,day_tokens:null});assert.deepEqual(readBudget(dir),{task_tokens:null,day_tokens:null});
  await assert.rejects(writeBudget(dir,{task_tokens:999,day_tokens:null}),/whole numbers/);
  for(const bad of [999,1_000_000_001,1500.5,'5000',null,-1])assert.equal(isBudgetTokens(bad),false,String(bad));
  await writeFile(path.join(dir,BUDGET_FILE),'{broken');assert.deepEqual(readBudget(dir),{task_tokens:null,day_tokens:null});
  await writeFile(path.join(dir,BUDGET_FILE),JSON.stringify({task_tokens:5,day_tokens:'x'}));assert.deepEqual(readBudget(dir),{task_tokens:null,day_tokens:null});
});
test('tokensToday counts the viewer\'s local day only',()=>{
  const now=Date.parse('2026-10-22T10:00:00Z');
  const records=[record({at:'2026-10-22T03:00:00.000Z',usage:{total_tokens:300}}),record({at:'2026-10-21T20:00:00.000Z',usage:{input_tokens:50,output_tokens:5}}),record({at:'2026-10-22T04:00:00.000Z',usage:null})];
  assert.equal(tokensToday(records,now,0),300);
  assert.equal(tokensToday(records,now,-420),355,'UTC+7: the 20:00Z record is already the next local day');
});

async function setup(){
  const root=await mkdtemp(path.join(tmpdir(),'agy-budget-run-'));const workspace=path.join(root,'work');await mkdir(workspace);const state=path.join(root,'state');await mkdir(state,{recursive:true});
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:state,launch:(_args,cwd)=>startProcess(process.execPath,[fixture,'usage'],cwd)});
  const bridge=await startHttpBridge({manager,missions:missionsFor(manager,workspace),environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  return {manager,bridge,workspace,state};
}

test('web UI: owner sets the limits; input is validated; the overview carries per-task tokens and the day total',async()=>{
  const {manager,bridge,workspace,state}=await setup();
  const api=(p:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{})}});
  const set=(body:unknown)=>api('budget',{method:'POST',body:JSON.stringify(body)});
  const overview=async()=>(await (await api('overview')).json()) as {budget:{task_tokens:number|null;day_tokens:number|null;today_tokens:number;over_day:boolean};tasks:{tokens:number|null}[]};
  try {
    for(const body of [{task_tokens:10},{day_tokens:'5000'},{task_tokens:2000000000},{day_tokens:1500.5}])assert.equal((await set(body)).status,400,JSON.stringify(body));
    assert.deepEqual(readBudget(state),{task_tokens:null,day_tokens:null});
    const task=await manager.delegate({task:'cost something',workspace,acceptance_criteria:['x']});await manager.waitFor(task.task_id,10);
    assert.equal(manager.get(task.task_id).status,'completed');
    const first=await overview();
    assert.equal(first.tasks[0].tokens,1280,'input + output from the fixture, which reports no total');
    assert.deepEqual(first.budget,{task_tokens:null,day_tokens:null,today_tokens:1280,over_day:false});
    const saved=(await (await set({day_tokens:1000})).json()) as {day_tokens:number;over_day:boolean;today_tokens:number};
    assert.equal(saved.day_tokens,1000);assert.equal(saved.over_day,true);
    assert.equal((await (await set({task_tokens:5000})).json() as {day_tokens:number}).day_tokens,1000,'a missing field keeps its value');
    assert.deepEqual(readBudget(state),{task_tokens:5000,day_tokens:1000});
    await set({task_tokens:null,day_tokens:null});assert.deepEqual((await overview()).budget.over_day,false);
    assert.ok((await budgetState(state,0)).today_tokens>=1280);void USAGE_FILE;
  } finally {await bridge.close();}
});
