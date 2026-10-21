import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskManager} from '../src/tasks/manager.js';
import {startProcess} from '../src/antigravity/process.js';

test('queued work is validated again and rejected before a process can touch changed workspace', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-queue-check-'));
  const workspace=path.join(root,'work'), outside=path.join(root,'outside'), stateDirectory=path.join(root,'state');
  await mkdir(workspace);await mkdir(outside);let launches=0;
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:30,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:2,extra_env_passthrough:[]},
    {executable:process.execPath,supported:true,stateDirectory,launch:(_args,cwd)=>{launches++;return startProcess(process.execPath,['-e','setInterval(()=>{},1000)'],cwd);}});
  try {
    const input={task:'mock',workspace,acceptance_criteria:['mock']};
    const active=await manager.delegate(input),queued=await manager.delegate(input);
    await symlink(outside,path.join(workspace,'escape'),process.platform==='win32'?'junction':'dir');
    await manager.cancel(active.task_id);const failed=await manager.wait(queued.task_id);
    assert.equal(failed.status,'failed');assert.match(failed.error!,/Queued workspace validation failed before execution/);
    assert.equal(failed.pid,null);assert.equal(launches,1);
  }finally{await manager.shutdown();}
});

test('the queued-to-running transition is durable before the executable starts', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-queue-record-')),workspace=path.join(root,'work'),stateDirectory=path.join(root,'state');await mkdir(workspace);
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:30,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:1,extra_env_passthrough:[]},
    {executable:process.execPath,supported:true,stateDirectory,launch:(_args,cwd)=>startProcess(process.execPath,['-e','setInterval(()=>{},1000)'],cwd)});
  try {
    const input={task:'mock',workspace,acceptance_criteria:['mock']};const active=await manager.delegate(input),queued=await manager.delegate(input);
    await manager.cancel(active.task_id);
    const deadline=Date.now()+3000;while(!manager.get(queued.task_id).process_running&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(manager.get(queued.task_id).process_running,true);
    const record=JSON.parse(await readFile(path.join(stateDirectory,'tasks',`${queued.task_id}.json`),'utf8'));
    assert.equal(record.task.status,'running');
  }finally{await manager.shutdown();}
});
