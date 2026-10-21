import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpBridge, configuredPort, DEFAULT_PORT } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { waitUntilDead } from './helpers.js';
import { loadHttpToken } from '../src/security/http-auth.js';

const token = 'test_token_123456789012345678901234567890';
const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));
const project = fileURLToPath(new URL('../../',import.meta.url));
async function setup(scenario='hang', port=0) {
  const root=await mkdtemp(path.join(tmpdir(),'agy-http-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),launch:(_args,cwd)=>startProcess(process.execPath,[fixture,scenario],cwd)});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock'},token,port});
  return {root,workspace,manager,bridge};
}
async function connect(url:string, credential=token, mode:'auto'|'legacy'='auto') {
  const client=new Client({name:'http-test',version:'1'}, {versionNegotiation:{mode}});
  try { await client.connect(new StreamableHTTPClientTransport(new URL(url), {requestInit:{headers:{Authorization:`Bearer ${credential}`}}})); }
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
test('bearer required, Host/Origin guarded, body bounded and both protocol eras connect',async()=>{
  const {bridge}=await setup();
  try {
    assert.equal((await fetch(bridge.healthUrl)).status,401);
    assert.equal((await fetch(bridge.mcpUrl,{headers:{Authorization:'Bearer wrong'}})).status,401);
    assert.equal((await fetch(bridge.healthUrl,{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}})).status,403);
    const badHost = await new Promise<number | undefined>((resolve,reject)=>{
      const req=request(bridge.healthUrl,{headers:{Authorization:`Bearer ${token}`,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();
    });
    assert.equal(badHost,403);
    assert.equal((await fetch(bridge.mcpUrl,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:' '.repeat(140000)})).status,413);
    const health=await fetch(bridge.healthUrl,{headers:{Authorization:`Bearer ${token}`}});assert.equal(health.status,200);
    for(const mode of ['auto','legacy'] as const) {const client=await connect(bridge.mcpUrl,token,mode);try{assert.equal((await client.listTools()).tools.length,6);assert.equal((await call(client,'antigravity_environment')).cli_version,'mock');}finally{await client.close();}}
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
test('token persists, secrets are not in startup log, server stays alive with stdin closed, PORT conflict is explicit',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agy-http-cli-'));
  const saved=process.env.BRIDGE_HTTP_TOKEN;delete process.env.BRIDGE_HTTP_TOKEN;
  try {const one=await loadHttpToken(root);const two=await loadHttpToken(root);assert.equal(one.token,two.token);assert.equal(await readFile(path.join(root,'http-token'),'utf8'),one.token);}finally{if(saved!==undefined)process.env.BRIDGE_HTTP_TOKEN=saved;}
  const config=path.join(root,'config.json');await writeFile(config,JSON.stringify({allowed_workspaces:[],executable:path.join(root,'missing.exe')}));
  const child=spawn(process.execPath,['dist/src/index.js'],{cwd:project,windowsHide:true,env:{...process.env,PORT:'0',BRIDGE_HTTP_TOKEN:token,ANTIGRAVITY_BRIDGE_CONFIG:config},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>log+=b);
  const ready=Date.now()+5000;while(!log.includes('MCP endpoint:') && Date.now()<ready)await new Promise(r=>setTimeout(r,20));
  try {
    const url=log.match(/MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/)?.[1];assert.ok(url,log);assert.equal(child.exitCode,null);assert.ok(!log.includes(token));
    const client=await connect(url);await client.close();assert.equal(child.exitCode,null);
    const conflict=spawn(process.execPath,['dist/src/index.js'],{cwd:project,windowsHide:true,env:{...process.env,PORT:new URL(url).port,BRIDGE_HTTP_TOKEN:token,ANTIGRAVITY_BRIDGE_CONFIG:config},stdio:['ignore','pipe','pipe']});
    let failure='';conflict.stderr.on('data',b=>failure+=b);const exit=await new Promise<number|null>(r=>conflict.once('close',r));assert.equal(exit,1);assert.match(failure,/Port is already in use/);assert.match(failure,/PORT/);assert.ok(!failure.includes(token));
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
  const env: NodeJS.ProcessEnv={...process.env,BRIDGE_HTTP_TOKEN:token,ANTIGRAVITY_BRIDGE_CONFIG:config};delete env.PORT;
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
    const result=await client.callTool({name:'antigravity_task_wait',arguments:{task_id:id,wait_seconds:26}});assert.equal(result.isError,true);
    const waited=await call(client,'antigravity_task_wait',{task_id:id,wait_seconds:5});assert.equal(waited.status,'completed');
    assert.equal((await call(client,'antigravity_task_output',{task_id:id})).final_response,'delayed response');
  } finally {await client.close();await bridge.close();}
});
const ui = (bridge:{baseUrl:string},path:string,init:RequestInit={},session?:string)=>fetch(`${bridge.baseUrl}/ui/api/${path}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{}),...(session?{'X-Bridge-Session':session}:{}),...init.headers}});
const signIn = async(bridge:{baseUrl:string})=>String(((await (await ui(bridge,'login',{method:'POST',body:JSON.stringify({token})})).json()) as {session:string}).session);
test('web UI: static shell is locked down, API needs a session obtained with the bridge token',async()=>{
  const {bridge}=await setup();
  try {
    const page=await fetch(`${bridge.baseUrl}/ui`);assert.equal(page.status,200);
    const csp=page.headers.get('content-security-policy')??'';assert.match(csp,/script-src 'self'/);assert.doesNotMatch(csp,/unsafe-inline/);
    assert.match(await page.text(),/Antigravity Bridge/);
    for(const [asset,type] of [['app.js','javascript'],['app.css','css'],['favicon.svg','svg']]) {const r=await fetch(`${bridge.baseUrl}/ui/${asset}`);assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',new RegExp(type));await r.arrayBuffer();}
    assert.equal((await fetch(`${bridge.baseUrl}/ui/missing`)).status,404);
    assert.equal((await fetch(`${bridge.baseUrl}/`,{redirect:'manual'})).status,302);
    assert.equal((await ui(bridge,'overview')).status,401);
    assert.equal((await ui(bridge,'overview',{},'forged')).status,401);
    assert.equal((await ui(bridge,'login',{method:'POST',body:JSON.stringify({token:'wrong'})})).status,401);
    assert.equal((await ui(bridge,'login',{method:'POST',body:JSON.stringify({})})).status,401);
    // Cookies are never used, so a bearer token alone does not open the UI API and vice versa.
    assert.equal((await fetch(`${bridge.baseUrl}/ui/api/overview`,{headers:{Authorization:`Bearer ${token}`}})).status,401);
    assert.equal((await fetch(bridge.mcpUrl,{headers:{'X-Bridge-Session':await signIn(bridge)}})).status,401);
    assert.equal((await fetch(`${bridge.baseUrl}/ui`,{headers:{Origin:'https://evil.example'}})).status,403);
  } finally {await bridge.close();}
});
test('web UI: overview and task detail expose the request/response exchange but never the token',async()=>{
  const {bridge,workspace,manager}=await setup('delayed');const client=await connect(bridge.mcpUrl);
  try {
    const session=await signIn(bridge);
    const started=await call(client,'antigravity_delegate',{task:'Add <b>feature</b> X',workspace,acceptance_criteria:['Criterion one','Criterion two'],context:'Some context',timeout_seconds:20});
    const id=String(started.task_id);
    const first=await (await ui(bridge,'overview',{},session)).text();
    const overview=JSON.parse(first);
    assert.equal(overview.tasks[0].task_id,id);assert.equal(overview.tasks[0].status,'running');assert.equal(overview.tasks[0].title,'Add <b>feature</b> X');assert.ok(!('stdout' in overview.tasks[0]));
    assert.equal(overview.delegation.enabled,true);assert.ok(Array.isArray(overview.allowed_workspaces));assert.equal(overview.server.mcp_endpoint,bridge.mcpUrl);
    await manager.wait(id);
    const detail=await (await ui(bridge,`tasks/${id}`,{},session)).json() as Record<string,any>;
    assert.equal(detail.task.final_response,'delayed response');
    assert.deepEqual(detail.request,{task:'Add <b>feature</b> X',acceptance_criteria:['Criterion one','Criterion two'],context:'Some context',timeout_seconds:20,client:'http-test 1'});
    assert.match(detail.prompt,/You are the Developer/);assert.match(detail.prompt,/Criterion two/);
    assert.ok(!JSON.stringify(detail).includes(token)&&!first.includes(token));
    assert.equal((await ui(bridge,'tasks/not-a-uuid',{},session)).status,404);
    assert.equal((await ui(bridge,'tasks/00000000-0000-4000-8000-000000000000',{},session)).status,404);
    // The MCP responses stay small: the request is not added to them.
    assert.ok(!('request' in await call(client,'antigravity_task_output',{task_id:id})));
    assert.equal((await ui(bridge,'logout',{method:'POST'},session)).status,200);
    assert.equal((await ui(bridge,'overview',{},session)).status,401);
  } finally {await client.close();await bridge.close();}
});
test('web UI: cancel and delegation switch work; env lock is respected; failed logins are throttled',async()=>{
  const {bridge,workspace,manager}=await setup('hang');const client=await connect(bridge.mcpUrl);
  const saved=process.env.BRIDGE_DELEGATION;delete process.env.BRIDGE_DELEGATION;
  try {
    const session=await signIn(bridge);
    const id=String((await call(client,'antigravity_delegate',{task:'mock hang',workspace,acceptance_criteria:['mock']})).task_id);
    const cancelled=await (await ui(bridge,`tasks/${id}/cancel`,{method:'POST'},session)).json() as Record<string,any>;assert.equal(cancelled.task.status,'canceled');
    const off=await (await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:false})},session)).json() as Record<string,any>;
    assert.equal(off.enabled,false);
    await assert.rejects(manager.delegate({task:'x',workspace,acceptance_criteria:['x']}),/disabled by the bridge owner/);
    assert.equal((await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:'yes'})},session)).status,400);
    const on=await (await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:true})},session)).json() as Record<string,any>;assert.equal(on.enabled,true);
    process.env.BRIDGE_DELEGATION='off';
    assert.equal((await ui(bridge,'delegation',{method:'POST',body:JSON.stringify({enabled:true})},session)).status,409);
    delete process.env.BRIDGE_DELEGATION;
    assert.equal((await ui(bridge,'overview',{},session).then(r=>r.json()) as Record<string,any>).delegation.controllable,true);
    for(let i=0;i<10;i++) assert.equal((await ui(bridge,'login',{method:'POST',body:JSON.stringify({token:'bad'})})).status,401);
    assert.equal((await ui(bridge,'login',{method:'POST',body:JSON.stringify({token})})).status,429);
  } finally {if(saved===undefined)delete process.env.BRIDGE_DELEGATION;else process.env.BRIDGE_DELEGATION=saved;await client.close();await bridge.close();}
});
test('client identity: modern clients are named by clientInfo, legacy ones fall back to the User-Agent',async()=>{
  const {bridge,workspace,manager}=await setup('delayed');
  try {
    for(const [mode,expected] of [['auto',/^http-test 1$/],['legacy',/^\S+/]] as const) {
      const client=await connect(bridge.mcpUrl,token,mode);
      try {
        const id=String((await call(client,'antigravity_delegate',{task:`who ${mode}`,workspace,acceptance_criteria:['x']})).task_id);
        await manager.wait(id);
        const label=manager.detail(id).request?.client;assert.match(String(label),expected);
      } finally {await client.close();}
    }
  } finally {await bridge.close();}
});
