import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {inspectCli,startProcess} from '../src/antigravity/process.js';
const fixture=fileURLToPath(new URL('../../tests/fixtures/inspect-agy.mjs',import.meta.url));
test('CLI accepts the agy 1.x line with complete help, warns for unverified releases and refuses other majors',async()=>{
  // agy updates itself, so a minor it ships must not stop delegation on a machine whose CLI is otherwise compatible; a
  // dropped required flag and a different major still have to fail closed.
  for(const [version,missing,supported,warn] of [['1.4.3','',true,false],['1.4.7','',true,false],['1.4.8','',true,false],['1.4.9','',true,false],['1.4.0','',true,true],['1.4.99','',true,true],['1.5.0','',true,true],['1.5.1','',true,false],['1.10.0','',true,true],['2.4.3','',false,false],['1.4.3','--print-timeout',false,false]] as const){
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
