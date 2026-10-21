import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {TaskManager} from '../src/tasks/manager.js';import {startProcess} from '../src/antigravity/process.js';
test('chunked output keeps full final content but publishes only bounded-frequency snapshots',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-output-')),workspace=path.join(root,'work');await mkdir(workspace);
  const script=`const output=JSON.stringify({status:'SUCCESS',response:'x'.repeat(1200),num_turns:1});let i=0;const timer=setInterval(()=>{process.stdout.write(output.slice(i,i+25));i+=25;if(i>=output.length){clearInterval(timer);process.stderr.write('api_key=fake-secret');}},30);`;
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:10,default_timeout_seconds:10,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(_args,cwd)=>startProcess(process.execPath,['-e',script],cwd)});
  try{
    const task=await manager.delegate({task:'mock chunks',workspace,acceptance_criteria:['mock']});let previous='',changes=0;
    while(manager.get(task.task_id).status==='running'){
      const snapshot=manager.get(task.task_id);if(snapshot.stdout!==previous){changes++;previous=snapshot.stdout;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const done=await manager.wait(task.task_id);assert.equal(done.status,'completed');assert.equal(done.final_response,'x'.repeat(1200));
    assert.ok(changes<=3,`too many partial snapshots: ${changes}`);assert.ok(!done.stderr.includes('fake-secret'));
    assert.equal(done.stdout_bytes,Buffer.byteLength(done.stdout));assert.equal(done.stdout_truncated,false);
  }finally{await manager.shutdown();}
});
