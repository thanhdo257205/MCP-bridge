import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {connect,type Socket} from 'node:net';import {once} from 'node:events';
test('repeated shutdown signals report cleanup in progress and let HTTP cleanup finish',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-signals-')),config=path.join(root,'workspaces.json');
  await writeFile(config,JSON.stringify({allowed_workspaces:[],executable:path.join(root,'missing')}));
  const entry=new URL('../src/index.js',import.meta.url).href;
  const wrapper=`process.on('message',value=>{if(value==='stop')process.emit('SIGINT');else process.disconnect();});await import(${JSON.stringify(entry)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',wrapper],{cwd:fileURLToPath(new URL('../../',import.meta.url)),windowsHide:true,
    env:{...process.env,BRIDGE_HOME:root,ANTIGRAVITY_BRIDGE_CONFIG:config,BRIDGE_HTTP_TOKEN:'signal_test_token_1234567890123456789012345',PORT:'0',BRIDGE_NO_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe','ipc']});
  let log='';child.stderr!.on('data',chunk=>log+=chunk);child.stdout!.resume();const exited=once(child,'close');let socket:Socket|undefined;
  const waitFor=async(value:string)=>{const until=Date.now()+10000;while(!log.includes(value)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));assert.ok(log.includes(value),log);};
  try{
    await waitFor('MCP endpoint:');const url=new URL(log.match(/MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/)![1]);
    socket=connect(Number(url.port),'127.0.0.1');
    // The server closes this half-sent request during shutdown, which can reach the client as ECONNRESET (seen on Windows); that is expected, not a failure.
    socket.on('error',()=>{});
    await once(socket,'connect');socket.write('GET /health HTTP/1.1\r\n');
    child.send('stop');child.send('stop');await waitFor('cleanup in progress, please wait');assert.equal(child.exitCode,null);
    socket.destroy();await waitFor('[bridge] Stopped');child.send('disconnect');const [code]=await exited;assert.equal(code,0);
  }finally{socket?.destroy();if(child.exitCode===null){child.kill();await exited;}}
});
