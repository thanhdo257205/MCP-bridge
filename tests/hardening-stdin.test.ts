import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {TaskManager} from '../src/tasks/manager.js';import {startProcess} from '../src/antigravity/process.js';import {finalEnvelope} from '../src/antigravity/invocation.js';
test('stdin sends one prompt without exposing it in argv; argv fallback remains available',async()=>{
  const fixture=fileURLToPath(new URL('../../tests/fixtures/stdin-agy.mjs',import.meta.url));
  for(const transport of ['stdin','argv'] as const){
    const root=await mkdtemp(path.join(tmpdir(),'bridge-stdin-')),workspace=path.join(root,'work');await mkdir(workspace);
    const marker='private-prompt-marker';
    const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:10,default_timeout_seconds:10,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:1,extra_env_passthrough:[],prompt_transport:transport},
      {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(args,cwd,options)=>{
        assert.equal(args.join(' ').includes(marker),transport==='argv');
        if(transport==='stdin')assert.ok(options?.stdin?.includes(marker));
        return startProcess(process.execPath,[fixture,...args],cwd,options);
      }});
    try{const task=await manager.delegate({task:marker,workspace,acceptance_criteria:['mock']});const done=await manager.wait(task.task_id);assert.equal(done.status,'completed');assert.equal(done.final_response,`${transport} received`);}finally{await manager.shutdown();}
  }
});
test('stdin parser rejects missing, malformed or multiple final results',()=>{
  for(const value of ['{"event":"init"}\n','bad json','{"event":"result","result":null}\n',Array(2).fill('{"event":"result","result":{"status":"SUCCESS"}}').join('\n')])assert.throws(()=>finalEnvelope(value,'stdin'));
});
