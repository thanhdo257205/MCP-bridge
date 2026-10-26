import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));

test('task_wait sends progress heartbeats while held when the client asked for them, and still returns the status',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agy-beat-'));const workspace=path.join(root,'work');await mkdir(workspace);const state=path.join(root,'state');await mkdir(state,{recursive:true});
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:4096,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:state,progressIntervalMs:100,launch:(_args,cwd)=>startProcess(process.execPath,[fixture,'delayed'],cwd)});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},port:0});
  const client=new Client({name:'beat-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)));
  try {
    const id=String(((await client.callTool({name:'antigravity_delegate',arguments:{task:'slow',workspace,acceptance_criteria:['x']}})).structuredContent as {task_id:string}).task_id);
    const beats:{progress:number;message?:string}[]=[];
    const result=await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:20}},{onprogress:p=>{beats.push({progress:p.progress,message:p.message});}});
    assert.equal((result.structuredContent as {status:string}).status,'completed');
    assert.ok(beats.length>=1,`expected at least one heartbeat, got ${beats.length}`);
    assert.deepEqual(beats.map(b=>b.progress),beats.map((_,i)=>i+1),'progress increases by one each time');
    assert.ok(beats.every(b=>typeof b.message==='string'&&b.message.length>0));
    // No progress token: the call behaves exactly as before.
    const again=await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:5}});
    assert.equal((again.structuredContent as {status:string}).status,'completed');
  } finally {await client.close();await bridge.close();}
});
