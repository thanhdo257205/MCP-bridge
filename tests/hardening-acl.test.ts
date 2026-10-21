import {test} from 'node:test';import assert from 'node:assert/strict';
import {hardenWindowsToken} from '../src/security/http-auth.js';
test('Windows token ACL uses the current SID and an argument vector; POSIX never invokes ACL tools',async()=>{
  const calls:{file:string;args:string[]}[]=[];
  await hardenWindowsToken('token path with spaces',{platform:'win32',run:async(file,args)=>{calls.push({file,args});return {stdout:'"account","S-1-5-21-111-222-333-1001"'};}});
  assert.equal(calls.length,2);assert.match(calls[0].file,/whoami\.exe$/);assert.match(calls[1].file,/icacls\.exe$/);
  assert.deepEqual(calls[1].args,['token path with spaces','/inheritance:r','/grant:r','*S-1-5-21-111-222-333-1001:(R,W)']);
  await hardenWindowsToken('unused',{platform:'linux',run:async()=>{throw new Error('must not run');}});
});
test('ACL failures warn without exposing secrets or preventing server startup',async()=>{
  const warnings:string[]=[];
  await hardenWindowsToken('private-token-path',{platform:'win32',run:async()=>{throw new Error('sensitive command details');},warn:m=>warnings.push(m)});
  assert.equal(warnings.length,1);assert.match(warnings[0],/ACL/);assert.ok(!warnings[0].includes('sensitive'));
});
