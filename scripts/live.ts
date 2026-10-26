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
