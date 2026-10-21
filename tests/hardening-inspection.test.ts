import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {inspectCli,startProcess} from '../src/antigravity/process.js';
test('CLI accepts the 1.4 patch family with complete help and warns for unverified patches',async()=>{
  const fixture=fileURLToPath(new URL('../../tests/fixtures/inspect-agy.mjs',import.meta.url));
  for(const [version,missing,supported,warn] of [['1.4.3','',true,false],['1.4.0','',true,true],['1.4.99','',true,true],['1.5.0','',false,false],['2.4.3','',false,false],['1.4.3','--print-timeout',false,false]] as const){
    const result=await inspectCli(process.execPath,process.cwd(),(_executable,args,cwd)=>startProcess(process.execPath,[fixture,version,missing,...args],cwd));
    assert.equal(result.supported,supported,`${version} ${missing}`);assert.equal(result.warnings.length>0,warn);
  }
});
