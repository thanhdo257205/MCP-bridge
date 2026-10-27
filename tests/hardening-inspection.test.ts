import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {inspectCli,startProcess} from '../src/antigravity/process.js';
const fixture=fileURLToPath(new URL('../../tests/fixtures/inspect-agy.mjs',import.meta.url));
test('CLI accepts the 1.4 patch family with complete help and warns for unverified patches',async()=>{
  for(const [version,missing,supported,warn] of [['1.4.3','',true,false],['1.4.7','',true,false],['1.4.0','',true,true],['1.4.99','',true,true],['1.5.0','',false,false],['2.4.3','',false,false],['1.4.3','--print-timeout',false,false]] as const){
    const result=await inspectCli({executable:process.execPath,prefixArgs:[fixture,version,missing],source:'fixture'},process.cwd());
    assert.equal(result.supported,supported,`${version} ${missing}`);assert.equal(result.warnings.length>0,warn);
  }
});
test('CLI inspection asks the command that was resolved, not the Node binary running a shim',async()=>{
  // A Windows npm install resolves `agy` to `node <entry>.js`; asking node --version would report Node and call agy unsupported.
  const command={executable:process.execPath,prefixArgs:[fixture,'1.4.7',''],source:'agy.cmd'};
  const spawned:string[][]=[];
  const result=await inspectCli(command,process.cwd(),(executable,args,cwd)=>{spawned.push([executable,...args]);return startProcess(executable,args,cwd);});
  assert.deepEqual(spawned,[[command.executable,...command.prefixArgs,'--version'],[command.executable,...command.prefixArgs,'--help']]);
  assert.equal(result.version,'1.4.7');
  assert.equal(result.supported,true);
  assert.deepEqual(result.prefixArgs,command.prefixArgs);
});
