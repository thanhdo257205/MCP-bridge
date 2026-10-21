import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {recoverExecutionLock} from '../src/tasks/execution-lock.js';

test('lock recovery requires both known PIDs dead and retains unreadable or live ownership',async()=>{
  for(const scenario of ['both-dead','server-live','child-live','missing','invalid'] as const){
    const state=await mkdtemp(path.join(tmpdir(),'bridge-lock-'));const lock=path.join(state,'execution.lock');await mkdir(lock);
    if(scenario!=='missing')await writeFile(path.join(state,'owner.json'),scenario==='invalid'?'{}':JSON.stringify({server_pid:1111,child_pid:2222}));
    const logs:string[]=[];const result=await recoverExecutionLock(state,{isAlive:pid=>scenario==='server-live'&&pid===1111||scenario==='child-live'&&pid===2222,log:m=>logs.push(m)});
    assert.equal(result.reclaimed,scenario==='both-dead');
    if(result.reclaimed){await assert.rejects(access(lock));assert.equal(logs.length,1);}else await access(lock);
  }
});
test('unlock CLI shares the safe recovery checks and diagnoses refusals',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'bridge-unlock-')),state=path.join(home,'state'),lock=path.join(state,'execution.lock');await mkdir(lock,{recursive:true});
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const run=()=>spawnSync(process.execPath,[cli,'unlock'],{encoding:'utf8',env:{...process.env,BRIDGE_HOME:home}});
  assert.equal(run().status,1);await access(lock);
  await writeFile(path.join(state,'owner.json'),JSON.stringify({server_pid:2147483646,child_pid:2147483645}));
  const result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/both dead/);await assert.rejects(access(lock));
});
