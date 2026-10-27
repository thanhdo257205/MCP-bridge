import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpBridge, configuredPort, DEFAULT_PORT } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { waitUntilDead, missionsFor } from './helpers.js';

const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));
const project = fileURLToPath(new URL('../../',import.meta.url));
async function setup(scenario='hang', port=0) {
  const root=await mkdtemp(path.join(tmpdir(),'agy-http-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(_args,cwd)=>startProcess(process.execPath,[fixture,scenario],cwd)});
  const environment:Record<string,unknown>={cli_version:'mock',allowed_workspaces:[workspace]};
  const bridge=await startHttpBridge({manager,missions:missionsFor(manager,workspace),environment,port});
  return {root,workspace,manager,bridge,environment};
}
async function connect(url:string, mode:'auto'|'legacy'='auto') {
  const client=new Client({name:'http-test',version:'1'}, {versionNegotiation:{mode}});
  try { await client.connect(new StreamableHTTPClientTransport(new URL(url))); }
  catch(error) { await client.close(); throw error; }
  return client;
}
const call = async(client:Client,name:string,args:Record<string,unknown>={})=>{
  const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent as Record<string,unknown>;
};
test('PORT validation, explicit alternative and transparent OS selection',async()=>{
  assert.equal(configuredPort('3001'),3001);assert.equal(configuredPort('0'),0);assert.equal(DEFAULT_PORT,3000);
  for(const value of ['-1','65536','abc','','3.5',' 3000']) assert.throws(()=>configuredPort(value));
  const reservation=createNetServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
  const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const {bridge}=await setup('hang',port);
  try {assert.equal(bridge.baseUrl,`http://127.0.0.1:${port}`);assert.equal(bridge.server.address() && (bridge.server.address() as {address:string}).address,'127.0.0.1');}
  finally{await bridge.close();}
});
test('no authentication, Host/Origin guarded, body bounded and both protocol eras connect',async()=>{
  const {bridge}=await setup();
  try {
    assert.equal((await fetch(bridge.healthUrl)).status,200);
    assert.equal((await fetch(bridge.healthUrl,{headers:{Origin:'https://evil.example'}})).status,403);
    const badHost = await new Promise<number | undefined>((resolve,reject)=>{
      const req=request(bridge.healthUrl,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();
    });
    assert.equal(badHost,403);
    assert.equal((await fetch(bridge.mcpUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(140000)})).status,413);
    assert.equal((await fetch(bridge.healthUrl,{headers:{Authorization:'Bearer anything'}})).status,200);
    for(const mode of ['auto','legacy'] as const) {const client=await connect(bridge.mcpUrl,mode);try{assert.equal((await client.listTools()).tools.length,13);assert.equal((await call(client,'antigravity_environment')).cli_version,'mock');assert.equal((await call(client,'agents_list')).default_agent,'antigravity');}finally{await client.close();}}
  } finally {await bridge.close();}
});
test('client disconnect preserves running task; reconnect can query and cancel it',async()=>{
  const {bridge,manager,workspace}=await setup();let client=await connect(bridge.mcpUrl);
  try {
    const started=await call(client,'antigravity_delegate',{task:'mock hang',workspace,acceptance_criteria:['mock']});
    const id=String(started.task_id);await client.close();
    await new Promise(r=>setTimeout(r,100));assert.equal(manager.get(id).status,'running');assert.equal(manager.get(id).process_running,true);
    client=await connect(bridge.mcpUrl);
    const environment=await call(client,'antigravity_environment');assert.ok(JSON.stringify(environment.recent_tasks).includes(id));
    assert.equal((await call(client,'antigravity_task_status',{task_id:id})).status,'running');
    assert.equal((await call(client,'antigravity_cancel_task',{task_id:id})).status,'canceled');
  } finally {await client.close();await bridge.close();}
});
test('disconnect allows task to complete and output to be recovered on reconnect',async()=>{
  const {bridge,manager,workspace}=await setup('delayed');let client=await connect(bridge.mcpUrl);
  try {
    const started=await call(client,'antigravity_delegate',{task:'mock delayed response',workspace,acceptance_criteria:['mock']});
    const id=String(started.task_id);await client.close();const done=await manager.wait(id);assert.equal(done.status,'completed');
    client=await connect(bridge.mcpUrl);assert.equal((await call(client,'antigravity_task_output',{task_id:id})).final_response,'delayed response');
  } finally {await client.close();await bridge.close();}
});
test('server shutdown stops acceptance, cleans child tree, closes listener and gives connection error',async()=>{
  const {bridge,manager,workspace}=await setup('tree');const client=await connect(bridge.mcpUrl);
  const started=await call(client,'antigravity_delegate',{task:'mock tree',workspace,acceptance_criteria:['mock']});const id=String(started.task_id);
  try {
    const until=Date.now()+3000;while(!manager.get(id).stderr && Date.now()<until) await new Promise(r=>setTimeout(r,20));
    const descendant=Number(manager.get(id).stderr);assert.ok(descendant>0);
    await bridge.close();assert.equal(manager.get(id).status,'canceled');assert.equal(manager.get(id).process_running,false);assert.equal(await waitUntilDead(descendant),true);
    await assert.rejects(manager.delegate({task:'no',workspace,acceptance_criteria:['no']}),/shutting down/);
    await assert.rejects(fetch(bridge.healthUrl,{signal:AbortSignal.timeout(2000)}));
    await assert.rejects(connect(bridge.mcpUrl));
  } finally {await client.close();await bridge.close();}
});
test('startup warns about the local trust model, server stays alive with stdin closed, PORT conflict is explicit',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agy-http-cli-'));
  const config=path.join(root,'config.json');await writeFile(config,JSON.stringify({allowed_workspaces:[],executable:path.join(root,'missing.exe')}));
  const child=spawn(process.execPath,['dist/src/index.js'],{cwd:project,windowsHide:true,env:{...process.env,PORT:'0',ANTIGRAVITY_BRIDGE_CONFIG:config},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>log+=b);
  const ready=Date.now()+5000;while(!log.includes('MCP endpoint:') && Date.now()<ready)await new Promise(r=>setTimeout(r,20));
  try {
    const url=log.match(/MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/)?.[1];assert.ok(url,log);assert.equal(child.exitCode,null);
    assert.match(log,/No authentication/);assert.match(log,/127\.0\.0\.1/);
    const client=await connect(url);await client.close();assert.equal(child.exitCode,null);
    const conflict=spawn(process.execPath,['dist/src/index.js'],{cwd:project,windowsHide:true,env:{...process.env,PORT:new URL(url).port,ANTIGRAVITY_BRIDGE_CONFIG:config},stdio:['ignore','pipe','pipe']});
    let failure='';conflict.stderr.on('data',b=>failure+=b);const exit=await new Promise<number|null>(r=>conflict.once('close',r));assert.equal(exit,1);assert.match(failure,/Port is already in use/);assert.match(failure,/PORT/);
  }finally{child.kill();await new Promise<void>(r=>child.once('close',()=>r()));}
});
test('occupied default port fails explicitly without trying another port',async()=>{
  const occupied=createNetServer();
  await new Promise<void>((resolve,reject)=>{
    occupied.once('error',error=>(error as NodeJS.ErrnoException).code==='EADDRINUSE'?resolve():reject(error));
    occupied.listen(DEFAULT_PORT,'127.0.0.1',resolve);
  });
  const root=await mkdtemp(path.join(tmpdir(),'agy-default-port-'));const config=path.join(root,'config.json');
  await writeFile(config,JSON.stringify({allowed_workspaces:[],executable:path.join(root,'missing.exe')}));
  const env: NodeJS.ProcessEnv={...process.env,ANTIGRAVITY_BRIDGE_CONFIG:config};delete env.PORT;
  try {
    const child=spawn(process.execPath,['dist/src/index.js'],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',b=>log+=b);child.stdout.resume();
    assert.equal(await new Promise<number|null>(resolve=>child.once('close',resolve)),1);
    assert.match(log,/Port is already in use/);assert.ok(!log.includes('MCP endpoint:'));
  } finally {if(occupied.listening)await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
});
test('status omits logs, wait tool returns running within its bound, output carries the response',async()=>{
  const {bridge,workspace}=await setup('delayed');const client=await connect(bridge.mcpUrl);
  try {
    const id=String((await call(client,'antigravity_delegate',{task:'mock delayed response',workspace,acceptance_criteria:['mock']})).task_id);
    const status=await call(client,'antigravity_task_status',{task_id:id});assert.ok(!('final_response' in status));assert.ok(!('stdout' in status));
    const result=await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:3601}});assert.equal(result.isError,true,'above the hard cap is rejected');
    const waited=await call(client,'antigravity_task_wait',{task_id:id,wait_seconds:5});assert.equal(waited.status,'completed');
    assert.equal((await call(client,'antigravity_task_output',{task_id:id})).final_response,'delayed response');
  } finally {await client.close();await bridge.close();}
});
const ui = (bridge:{baseUrl:string},path:string,init:RequestInit={})=>fetch(`${bridge.baseUrl}/ui/api/${path}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{}),...init.headers}});
test('web UI: static shell is locked down and the API is reachable without a login',async()=>{
  const {bridge}=await setup();
  try {
    const page=await fetch(`${bridge.baseUrl}/ui`);assert.equal(page.status,200);
    const csp=page.headers.get('content-security-policy')??'';assert.match(csp,/script-src 'self'/);assert.doesNotMatch(csp,/unsafe-inline/);
    assert.match(await page.text(),/Antigravity Bridge/);
    for(const [asset,type] of [['app.js','javascript'],['app.css','css'],['favicon.svg','svg']]) {const r=await fetch(`${bridge.baseUrl}/ui/${asset}`);assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',new RegExp(type));await r.arrayBuffer();}
    assert.equal((await fetch(`${bridge.baseUrl}/ui/missing`)).status,404);
    assert.equal((await fetch(`${bridge.baseUrl}/`,{redirect:'manual'})).status,302);
    assert.equal((await ui(bridge,'overview')).status,200);
    assert.equal((await ui(bridge,'login',{method:'POST',body:JSON.stringify({})})).status,404);
    assert.equal((await fetch(`${bridge.baseUrl}/ui`,{headers:{Origin:'https://evil.example'}})).status,403);
  } finally {await bridge.close();}
});
test('web UI: overview and task detail expose the request/response exchange',async()=>{
  const {bridge,workspace,manager}=await setup('delayed');const client=await connect(bridge.mcpUrl);
  try {
    const started=await call(client,'antigravity_delegate',{task:'Add <b>feature</b> X',workspace,acceptance_criteria:['Criterion one','Criterion two'],context:'Some context',timeout_seconds:20});
    const id=String(started.task_id);
    const overview=await (await ui(bridge,'overview')).json() as Record<string,any>;
    assert.equal(overview.tasks[0].task_id,id);assert.equal(overview.tasks[0].status,'running');assert.equal(overview.tasks[0].title,'Add <b>feature</b> X');assert.ok(!('stdout' in overview.tasks[0]));
    assert.equal(overview.delegation.enabled,true);assert.ok(Array.isArray(overview.allowed_workspaces));assert.equal(overview.server.mcp_endpoint,bridge.mcpUrl);
    await manager.wait(id);
    const detail=await (await ui(bridge,`tasks/${id}`)).json() as Record<string,any>;
    assert.equal(detail.task.final_response,'delayed response');
    assert.deepEqual(detail.request,{task:'Add <b>feature</b> X',acceptance_criteria:['Criterion one','Criterion two'],context:'Some context',timeout_seconds:20,client:'http-test 1',agent:'antigravity',isolation:'none',owns:[],autonomy:'auto',model:null,permission:'default',effort:'default'});
    assert.equal(detail.task.agent,'antigravity');assert.equal(detail.task.isolation,'none');assert.equal(detail.task.autonomy,'auto');
    assert.deepEqual(overview.concurrency,{normal_running:1,worktrees_running:0,max_parallel_worktrees:2});
    assert.equal(overview.default_agent,'antigravity');assert.equal(overview.agents[0].id,'antigravity');assert.equal(overview.default_autonomy,'auto');
    assert.match(detail.prompt,/You are the Developer/);assert.match(detail.prompt,/Criterion two/);
    assert.equal((await ui(bridge,'tasks/not-a-uuid')).status,404);
    assert.equal((await ui(bridge,'tasks/00000000-0000-4000-8000-000000000000')).status,404);
    // The MCP responses stay small: the request is not added to them.
    assert.ok(!('request' in await call(client,'antigravity_task_output',{task_id:id})));
  } finally {await client.close();await bridge.close();}
});
test('web UI: the task page is handed the verdict on the trees the agent left behind',async()=>{
  // The release runs after the status publish, so the page has to pick it up on a later refresh. Without this the
  // only way to see what was reaped, or which branch was deliberately left running, is the JSON file on disk.
  const root=await mkdtemp(path.join(tmpdir(),'agy-http-cleanup-'));
  const workspace=path.join(root,'work');await mkdir(workspace);
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),
      launch:(_args,cwd)=>startProcess(process.execPath,[fixture,'ok'],cwd),
      reapTree:async()=>({checked:true,reaped:[601],skipped:[{pid:602,name:'node.exe',guard:'pid was reissued to another process after the tree query'}],tracked:2})});
  const bridge=await startHttpBridge({manager,missions:missionsFor(manager,workspace),environment:{},port:0});
  try {
    const id=String((await manager.delegate({task:'mock',workspace,acceptance_criteria:['ok']})).task_id);
    await manager.wait(id);
    let detail=await (await ui(bridge,`tasks/${id}`)).json() as Record<string,any>;
    for(let tries=0;tries<60 && !detail.task?.cleanup;tries++){await new Promise(resolve=>setTimeout(resolve,50));detail=await (await ui(bridge,`tasks/${id}`)).json() as Record<string,any>;}
    assert.equal(detail.task.cleanup.checked,true,'the report lands on the page a moment later');
    assert.deepEqual(detail.task.cleanup.reaped,[601]);
    assert.match(detail.task.cleanup.skipped[0].guard,/reissued/,'the reason a branch was left running reaches the page too');
    assert.equal(detail.task.cleanup.tracked,2);
  } finally {await bridge.close();}
});
test('web UI: cancel and delegation switch work and the env lock is respected',async()=>{
  const {bridge,workspace,manager}=await setup('hang');const client=await connect(bridge.mcpUrl);
  const saved=process.env.BRIDGE_DELEGATION;delete process.env.BRIDGE_DELEGATION;
  try {
    const id=String((await call(client,'antigravity_delegate',{task:'mock hang',workspace,acceptance_criteria:['mock']})).task_id);
    const cancelled=await (await ui(bridge,`tasks/${id}/cancel`,{method:'POST'})).json() as Record<string,any>;assert.equal(cancelled.task.status,'canceled');
    const off=await (await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:false})})).json() as Record<string,any>;
    assert.equal(off.enabled,false);
    await assert.rejects(manager.delegate({task:'x',workspace,acceptance_criteria:['x']}),/disabled by the bridge owner/);
    assert.equal((await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:'yes'})})).status,400);
    const on=await (await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:true})})).json() as Record<string,any>;assert.equal(on.enabled,true);
    process.env.BRIDGE_DELEGATION='off';
    assert.equal((await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:true})})).status,409);
    delete process.env.BRIDGE_DELEGATION;
    assert.equal((await ui(bridge,'overview').then(r=>r.json()) as Record<string,any>).delegation.controllable,true);
  } finally {if(saved===undefined)delete process.env.BRIDGE_DELEGATION;else process.env.BRIDGE_DELEGATION=saved;await client.close();await bridge.close();}
});
test('web UI: shutdown requires confirmation and stops the server plus owned tasks',async()=>{
  const {bridge,workspace,manager}=await setup('hang');const client=await connect(bridge.mcpUrl);
  try {
    const id=String((await call(client,'antigravity_delegate',{task:'mock hang',workspace,acceptance_criteria:['mock']})).task_id);
    assert.equal((await ui(bridge,'shutdown',{method:'POST',body:JSON.stringify({})})).status,400);
    assert.equal((await ui(bridge,'shutdown')).status,404);
    assert.equal((await fetch(bridge.healthUrl)).status,200);
    const response=await ui(bridge,'shutdown',{method:'POST',body:JSON.stringify({confirm:true})});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),{status:'shutting_down'});
    const deadline=Date.now()+10000;
    while(manager.get(id).status==='running' && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    assert.equal(manager.get(id).status,'canceled');
    await assert.rejects(fetch(bridge.healthUrl));
  } finally {await client.close();await bridge.close();}
});
test('web UI: a running task reports when its process last produced output',async()=>{
  const {bridge,workspace,manager}=await setup('hang');
  try {
    const task=await manager.delegate({task:'mock hang',workspace,acceptance_criteria:['mock']});
    const early=await (await ui(bridge,`tasks/${task.task_id}`)).json() as {activity:{last_output_at:string|null}};
    for(let i=0;i<50&&!(await (await ui(bridge,`tasks/${task.task_id}`)).json() as {activity:{last_output_at:string|null}}).activity.last_output_at;i++)await new Promise(r=>setTimeout(r,100));
    const later=await (await ui(bridge,`tasks/${task.task_id}`)).json() as {activity:{last_output_at:string|null}};
    assert.ok(early.activity.last_output_at===null||typeof early.activity.last_output_at==='string');
    assert.match(String(later.activity.last_output_at),/^\d{4}-\d\d-\d\dT/);
    assert.ok(!('activity' in await manager.get(task.task_id)),'MCP task data stays unchanged');
    await manager.cancel(task.task_id);
  } finally {await bridge.close();}
});
test('client identity: modern clients are named by clientInfo, legacy ones fall back to the User-Agent',async()=>{
  const {bridge,workspace,manager}=await setup('delayed');
  try {
    for(const [mode,expected] of [['auto',/^http-test 1$/],['legacy',/^\S+/]] as const) {
      const client=await connect(bridge.mcpUrl,mode);
      try {
        const id=String((await call(client,'antigravity_delegate',{task:`who ${mode}`,workspace,acceptance_criteria:['x']})).task_id);
        await manager.wait(id);
        const label=manager.detail(id).request?.client;assert.match(String(label),expected);
      } finally {await client.close();}
    }
  } finally {await bridge.close();}
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const gitIn = (cwd:string,...args:string[]) => execFileSync('git',['-c','user.name=t','-c','user.email=t@example.com','-c','commit.gpgsign=false',...args],{cwd,stdio:'ignore'});
test('web UI: workspace changes endpoint is read-only and honors the allowlist', {skip: hasGit ? false : 'git is not installed'}, async()=>{
  const {bridge,workspace,manager,environment}=await setup('delayed');const client=await connect(bridge.mcpUrl);
  try {
    const id=String((await call(client,'antigravity_delegate',{task:'change things',workspace,acceptance_criteria:['x']})).task_id);await manager.wait(id);
    assert.equal((await ui(bridge,`tasks/00000000-0000-4000-8000-000000000000/changes`)).status,404);
    const plain=await (await ui(bridge,`tasks/${id}/changes`)).json() as Record<string,any>;
    assert.equal(plain.available,false);assert.match(plain.reason,/Not a usable git repository/);
    gitIn(workspace,'init','-q');await writeFile(path.join(workspace,'a.txt'),'one\n');gitIn(workspace,'add','.');gitIn(workspace,'commit','-qm','init');
    await writeFile(path.join(workspace,'a.txt'),'one\ntwo\n');await writeFile(path.join(workspace,'fresh.txt'),'new');
    const report=await (await ui(bridge,`tasks/${id}/changes`)).json() as Record<string,any>;
    assert.equal(report.available,true,report.reason);
    assert.deepEqual(report.changes,[{path:'a.txt',status:'modified',added:1,deleted:0}]);
    assert.deepEqual(report.untracked,[{path:'fresh.txt',bytes:3}]);
    assert.equal(await readFile(path.join(workspace,'a.txt'),'utf8'),'one\ntwo\n','the endpoint changed nothing');
    environment.allowed_workspaces=[];
    const denied=await (await ui(bridge,`tasks/${id}/changes`)).json() as Record<string,any>;
    assert.equal(denied.available,false);assert.match(denied.reason,/no longer in the allowlist/);
  } finally {await client.close();await bridge.close();}
});
