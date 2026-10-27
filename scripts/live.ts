import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const results = path.join(root,'test-results');
const workspace = path.join(results,`live-${Date.now()}`);
await mkdir(workspace,{recursive:true});
await writeFile(path.join(workspace,'sentinel.txt'),'UNCHANGED');
const configPath = path.join(workspace,'..',`config-${Date.now()}.json`);
await writeFile(configPath,JSON.stringify({allowed_workspaces:[workspace],executable:'agy'}));
let client = new Client({name:'bridge-live-verifier',version:'0.1.0'});
// IPC is test-harness control only: exercise the same SIGINT shutdown handler on Windows.
const server=spawn(process.execPath,['--input-type=module','-e',"await import('./dist/src/index.js'); process.on('message',()=>{process.emit('SIGINT');process.disconnect();});"],
  {cwd:root,windowsHide:true,env:{...process.env,PORT:'0',ANTIGRAVITY_BRIDGE_CONFIG:configPath},stdio:['ignore','pipe','pipe','ipc']});
const exited=new Promise<number|null>(resolve=>server.once('close',resolve));
let diagnostics=''; server.stderr!.on('data',(data:Buffer)=>diagnostics+=data.toString());server.stdout!.resume();
let endpoint = '';
const connect = () => client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
const call = async (name:string,args:Record<string,unknown>={}) => {
  const result=await client.callTool({name,arguments:args});
  if(result.isError) throw new Error(JSON.stringify(result));
  return result.structuredContent as Record<string,unknown>;
};
// A refusal is part of the contract, so it is asserted as a real tool error with the real reason, not swallowed by call().
const expectRefused = async (name:string,args:Record<string,unknown>,matches:RegExp) => {
  const result=await client.callTool({name,arguments:args});
  // The error text is quoted JSON, so unescape it: the reason strings themselves contain the quotes a refusal puts around a step id.
  const text=JSON.stringify(result.structuredContent ?? result.content).replace(/\\"/g,'"');
  assert.ok(result.isError,`${name} was expected to be refused but returned ${text}`);
  assert.match(text,matches,`${name} refused for the wrong reason: ${text}`);
  return text;
};
const report: Record<string,unknown> = {started_at:new Date().toISOString(),workspace,kind:'REAL_AGY_NOT_MOCK',transport:'streamable-http'};
let activeTask: string | undefined;
try {
  const ready=Date.now()+30000;
  while(!diagnostics.includes('MCP endpoint:') && Date.now()<ready && server.exitCode===null) await new Promise(r=>setTimeout(r,50));
  endpoint=diagnostics.match(/MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/)?.[1] ?? '';
  assert.ok(endpoint,'HTTP server did not start');report.endpoint=endpoint;
  await connect();
  const environment=await call('antigravity_environment');
  assert.match(String(environment.cli_version),/^1\.4\.\d+$/);assert.equal(environment.bridge_status,'ready');
  report.environment=environment;
  const task=await call('antigravity_delegate',{
    task:'Reply with exactly BRIDGE_SMOKE_OK. Do not use any tools, read files, change files or run commands.',
    workspace,acceptance_criteria:['Response is exactly BRIDGE_SMOKE_OK','No files changed; no commands executed'],timeout_seconds:90
  });
  activeTask=String(task.task_id);
  await client.close();
  await new Promise(resolve=>setTimeout(resolve,500));
  client=new Client({name:'bridge-live-reconnect',version:'0.1.0'});
  await connect();
  report.reconnected=true;
  const deadline=Date.now()+100000;
  let status:Record<string,unknown> = task;
  while(status.status==='running' && Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,500));status=await call('antigravity_task_status',{task_id:activeTask});
  }
  const output=await call('antigravity_task_output',{task_id:activeTask});report.task=output;
  assert.equal(status.status,'completed');
  assert.equal(String(output.final_response).trim(),'BRIDGE_SMOKE_OK');
  assert.equal(await readFile(path.join(workspace,'sentinel.txt'),'utf8'),'UNCHANGED');
  assert.deepEqual(await readdir(workspace),['sentinel.txt']);
  report.response_verified=true;
  report.workspace_unchanged=true;
  // A real plan over the real agent: every refusal below is production behaviour that a fake-CLI unit test cannot claim.
  const step = (id:string, depends_on:string[]) => ({step_id:id, title:`Reply BRIDGE_MISSION_${id}`, depends_on, delegate:{
    task:`Reply with exactly BRIDGE_MISSION_${id}. Do not use any tools, read files, change files or run commands.`,
    workspace, acceptance_criteria:[`Response is exactly BRIDGE_MISSION_${id}`,'No files changed; no commands executed'], timeout_seconds:90}});
  const receipt = await call('mission_create',{title:'Live mission: three bounded replies in dependency order',
    goal:'prove the dispatch gate, the append-only plan and the cancel rule against a real agent',
    workspace, steps:[step('a',[]), step('b',['a']), step('c',['b'])]});
  const mission_id=String(receipt.mission_id);
  const stepsRun:Record<string,unknown>[] = [];
  const evidence:Record<string,unknown> = {mission_id, receipt, steps:stepsRun};
  report.mission=evidence;
  assert.deepEqual(receipt.ready,['a']);
  assert.equal(JSON.stringify(receipt).includes('BRIDGE_MISSION_a'),false,'a receipt must not echo the plan back over the wire');
  evidence.dependency_refused=await expectRefused('mission_dispatch',{mission_id,step_id:'b'},/is not ready: "a" is ready/);
  evidence.unmet_chain=await expectRefused('mission_dispatch',{mission_id,step_id:'c'},/"b" is pending/);
  const wait_for = async (task_id:string) => {
    const until=Date.now()+150000;
    for(;;){const status=await call('antigravity_task_status',{task_id});
      if(status.status!=='running'&&status.status!=='queued')return status;
      if(Date.now()>until) throw new Error(`live mission task ${task_id} never finished`);
      await new Promise(resolve=>setTimeout(resolve,2000));}
  };
  const runStep = async (id:string) => {
    const started=await call('mission_dispatch',{mission_id,step_id:id});
    activeTask=String(started.task_id);
    const status=await wait_for(activeTask);
    const output=await call('antigravity_task_output',{task_id:activeTask});
    assert.equal(String(output.final_response).trim(),`BRIDGE_MISSION_${id}`,`step ${id} did not answer with what its plan recorded`);
    stepsRun.push({step_id:id, task_id:activeTask, status:status.status, response:String(output.final_response).trim()});
    activeTask=undefined;
  };
  await runStep('a');
  evidence.rebound_refused=await expectRefused('mission_dispatch',{mission_id,step_id:'a'},/already bound to task/);
  assert.deepEqual((await call('mission_status',{mission_id})).ready,['b'],'a completed step must open exactly its dependent');
  await runStep('b');
  assert.deepEqual((await call('mission_status',{mission_id})).ready,['c']);
  await runStep('c');
  const done=await call('mission_status',{mission_id});
  assert.deepEqual(done.progress,{total:3,completed:3,active:0,ready:0,pending:0,unmet:0});
  evidence.final_status=done;
  evidence.plan_steps=((await call('mission_plan',{mission_id})).steps as unknown[]).length;
  evidence.retry_refused=await expectRefused('mission_dispatch',{mission_id,step_id:'a'},/append-only/);
  const extended=await call('mission_extend',{mission_id,steps:[step('d',['c'])]});
  assert.deepEqual(extended.ready,['d'],'a correction step appended to a finished plan must be dispatchable');
  const stopped=await call('mission_cancel',{mission_id});
  assert.equal(stopped.status,'canceled');
  evidence.after_cancel_refused=await expectRefused('mission_dispatch',{mission_id,step_id:'d'},/is canceled: no step can be dispatched/);
  evidence.after_extend_refused=await expectRefused('mission_extend',{mission_id,steps:[step('e',[])]},/can no longer change/);
  assert.equal(await readFile(path.join(workspace,'sentinel.txt'),'utf8'),'UNCHANGED');
  assert.deepEqual(await readdir(workspace),['sentinel.txt']);
  evidence.workspace_unchanged=true;
  // Verify cancel with a real owned agy process; do not depend on a model running tools.
  const cancelTask=await call('antigravity_delegate',{task:'Reply OK. Do not use any tools or change files.',workspace,acceptance_criteria:['Reply received'],timeout_seconds:30});
  activeTask=String(cancelTask.task_id);
  report.cancellation=await call('antigravity_cancel_task',{task_id:activeTask});
  assert.equal((report.cancellation as Record<string,unknown>).status,'canceled');
  const shutdownTask=await call('antigravity_delegate',{task:'Reply OK. Do not use any tools or change files.',workspace,acceptance_criteria:['Reply received'],timeout_seconds:30});
  report.shutdown_task={task_id:shutdownTask.task_id,pid:shutdownTask.pid,initial_status:shutdownTask.status};
  activeTask=undefined;
  report.success=true;
} catch(error) {
  report.success=false;report.error=error instanceof Error?error.message:String(error);process.exitCode=1;
} finally {
  if(activeTask) await call('antigravity_cancel_task',{task_id:activeTask}).catch(()=>{});
  await client.close();
  if(server.connected) server.send('stop');
  let watchdog: NodeJS.Timeout | undefined;
  try { report.server_exit_code=await Promise.race([exited,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>{server.kill();reject(new Error('Server shutdown timed out'));},10000)})]); }
  catch {report.success=false;report.shutdown_error='Server failed to stop gracefully';process.exitCode=1;}
  finally {if(watchdog)clearTimeout(watchdog);}
  if(report.shutdown_task) {
    const pid=(report.shutdown_task as Record<string,unknown>).pid as number;
    try {process.kill(pid,0);report.success=false;report.shutdown_error='Owned CLI process still exists';process.exitCode=1;}
    catch {report.shutdown_with_active_task_verified=true;}
    if(report.server_exit_code!==0 || !diagnostics.includes('[bridge] Stopped')) {report.success=false;process.exitCode=1;}
  }
  report.finished_at=new Date().toISOString();report.server_diagnostics=diagnostics;
  await writeFile(path.join(results,'live-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
