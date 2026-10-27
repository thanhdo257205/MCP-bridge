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
import { PERMISSION_FILE, PERMISSION_LEVELS, lowerLevel, permissionFlags, permissionState, writePermission } from '../src/permissions.js';
import { missionsFor } from './helpers.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('permission levels map to the agy flags and nothing else',()=>{
  assert.deepEqual(permissionFlags('default'),[]);
  assert.deepEqual(permissionFlags('plan'),['--mode','plan']);
  assert.deepEqual(permissionFlags('accept-edits'),['--mode','accept-edits']);
  assert.deepEqual(permissionFlags('auto'),['--mode','auto']);
  assert.deepEqual(permissionFlags('full'),['--dangerously-skip-permissions']);
  assert.deepEqual([...PERMISSION_LEVELS],['default','plan','accept-edits','auto','full']);
  assert.equal(lowerLevel('full','plan'),'plan');assert.equal(lowerLevel('default','full'),'default');assert.equal(lowerLevel('auto','auto'),'auto');
  const args=invocationFor('p',30,'argv','m',permissionFlags('full')).args;assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!invocationFor('p',30,'argv').args.includes('--dangerously-skip-permissions'));
});
test('permission state: default, file, environment lock; anything unknown means least privilege',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-perm-'));
  assert.deepEqual(permissionState(dir,{}),{level:'default',source:'default',controllable:true,reason:null});
  await writePermission(dir,'accept-edits');assert.equal(permissionState(dir,{}).level,'accept-edits');assert.equal(permissionState(dir,{}).source,'file');
  const forced=permissionState(dir,{BRIDGE_AGY_PERMISSIONS:' FULL '});assert.equal(forced.level,'full');assert.equal(forced.controllable,false);
  const invalid=permissionState(dir,{BRIDGE_AGY_PERMISSIONS:'root'});assert.equal(invalid.level,'default');assert.equal(invalid.controllable,false);assert.match(String(invalid.reason),/invalid/);
  await writeFile(path.join(dir,PERMISSION_FILE),JSON.stringify({level:'root'}));assert.equal(permissionState(dir,{}).level,'default');
  await writeFile(path.join(dir,PERMISSION_FILE),'{broken');assert.equal(permissionState(dir,{}).level,'default');
  await writePermission(dir,'full');await writePermission(dir,'default');assert.equal(permissionState(dir,{}).source,'default','default removes the file');
});

async function setup(scenario:string,queued=0){
  const root=await mkdtemp(path.join(tmpdir(),'agy-perm-ui-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const state=path.join(root,'state');const launched:string[][]=[];
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:queued,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:state,launch:(args,cwd)=>{launched.push(args);return startProcess(process.execPath,[fixture,scenario],cwd);}});
  const bridge=await startHttpBridge({manager,missions:missionsFor(manager,workspace),environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  const api=(p:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{})}});
  return {manager,bridge,api,workspace,state,launched};
}
const has=(args:string[],flag:string)=>args.includes(flag);

test('web UI: only the owner sets the level; risky levels need acknowledgement; the environment can lock it',async()=>{
  const saved=process.env.BRIDGE_AGY_PERMISSIONS;delete process.env.BRIDGE_AGY_PERMISSIONS;
  const {bridge,api,manager}=await setup('ok');
  const set=(body:unknown)=>api('permission',{method:'POST',body:JSON.stringify(body)});
  try {
    const overview=await (await api('overview')).json() as {permission:{level:string;controllable:boolean}};assert.equal(overview.permission.level,'default');assert.equal(overview.permission.controllable,true);
    for(const level of ['root','',42,undefined,null])assert.equal((await set({level})).status,400,String(level));
    assert.equal((await set({level:'full'})).status,400,'full without acknowledgement');
    assert.equal((await set({level:'auto',acknowledge_risk:'yes'})).status,400,'only boolean true counts');
    assert.equal((await set({level:'accept-edits'})).status,200,'a lower level needs no acknowledgement');
    assert.equal((await set({level:'full',acknowledge_risk:true})).status,200);
    assert.equal(manager.overview().agy_permissions,'full','the environment tool reports the level');
    assert.equal(((await (await api('overview')).json()) as {permission:{level:string}}).permission.level,'full');
    process.env.BRIDGE_AGY_PERMISSIONS='plan';
    assert.equal((await set({level:'full',acknowledge_risk:true})).status,409,'locked by the environment');
    assert.equal(manager.overview().agy_permissions,'plan','the environment wins over the file');
  } finally {if(saved===undefined)delete process.env.BRIDGE_AGY_PERMISSIONS;else process.env.BRIDGE_AGY_PERMISSIONS=saved;await bridge.close();}
});
test('tasks run with the level in force; lowering applies to queued tasks, raising never does',async()=>{
  const saved=process.env.BRIDGE_AGY_PERMISSIONS;delete process.env.BRIDGE_AGY_PERMISSIONS;
  const {bridge,manager,workspace,state,launched}=await setup('delayed',1);
  const input={workspace,acceptance_criteria:['x']};
  try {
    await writePermission(state,'full');
    const first=await manager.delegate({...input,task:'one'});assert.ok(has(launched[0],'--dangerously-skip-permissions'));assert.equal(manager.detail(first.task_id).request?.permission,'full');
    const second=await manager.delegate({...input,task:'two'});assert.equal(second.status,'queued');
    await writePermission(state,'default');
    await manager.waitFor(second.task_id,10);await manager.waitFor(second.task_id,10);
    assert.ok(!has(launched[1],'--dangerously-skip-permissions'),'lowered while queued: runs without the flag');
    assert.equal(manager.detail(second.task_id).request?.permission,'default');
    const third=await manager.delegate({...input,task:'three'});const fourth=await manager.delegate({...input,task:'four'});assert.equal(fourth.status,'queued');
    await writePermission(state,'full');
    await manager.waitFor(third.task_id,10);await manager.waitFor(fourth.task_id,10);await manager.waitFor(fourth.task_id,10);
    const fourthArgs=launched[3];assert.ok(fourthArgs&&!has(fourthArgs,'--dangerously-skip-permissions'),'raised while queued: keeps the level it was accepted with');
    assert.equal(manager.detail(fourth.task_id).request?.permission,'default');
  } finally {if(saved===undefined)delete process.env.BRIDGE_AGY_PERMISSIONS;else process.env.BRIDGE_AGY_PERMISSIONS=saved;await bridge.close();}
});
