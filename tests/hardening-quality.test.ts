import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {compareVersions,readPackageInfo} from '../src/update.js';import {promptFor} from '../src/security/input.js';
import {startHttpBridge} from '../src/http.js';import {TaskManager} from '../src/tasks/manager.js';
import {missionsFor} from './helpers.js';
test('prerelease version identifiers compare numerically, by type, prefix and without build metadata',()=>{
  for(const [a,b] of [['1.0.0-rc.2','1.0.0-rc.10'],['1.0.0-rc.10','1.0.0-rc.11'],['1.0.0-1','1.0.0-alpha'],['1.0.0-alpha','1.0.0-alpha.1'],['1.0.0-alpha-x.2','1.0.0-alpha-x.10'],['1.0.0-rc.9007199254740992','1.0.0-rc.9007199254740993']]){
    assert.ok(compareVersions(a,b)<0,`${a} < ${b}`);assert.ok(compareVersions(b,a)>0);
  }
  assert.equal(compareVersions('1.0.0+first','1.0.0+second'),0);
});
test('Developer prompts identify the actual Tech Lead and escape client-label control characters',()=>{
  const input={task:'mock',workspace:process.cwd(),acceptance_criteria:['mock']};
  for(const client of ['Codex 1','Claude Code 2','Other\nclient']){
    const prompt=promptFor(input,client);assert.ok(prompt.includes(JSON.stringify(client)));
    assert.ok(!prompt.includes('Codex is Tech Lead'));if(client.includes('\n'))assert.ok(!prompt.includes(client));
  }
});
test('MCP handshake and web UI report the package manifest version',async()=>{
  const stateDirectory=await mkdtemp(path.join(tmpdir(),'bridge-version-'));
  const manager=new TaskManager({allowed_workspaces:[],executable:'missing',max_timeout_seconds:10,default_timeout_seconds:10,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'stdin'},{executable:'missing',supported:false,stateDirectory});
  const bridge=await startHttpBridge({manager,missions:missionsFor(manager),environment:{},port:0});
  const client=new Client({name:'version-test',version:'1'},{versionNegotiation:{mode:'legacy'}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpUrl)));
    assert.equal(client.getServerVersion()?.version,readPackageInfo().version);
    const overview=await (await fetch(`${bridge.baseUrl}/ui/api/overview`)).json() as {server:{version:string}};
    assert.equal(overview.server.version,readPackageInfo().version);
  }finally{await client.close();await bridge.close();}
});
