import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {childEnvironment,startProcess,withWindowsDefaults} from '../src/antigravity/process.js';
test('environment policy matches case-insensitively and only forwards sensitive names by explicit opt-in',()=>{
  const env={Path:'bin',home:'home',LC_ALL:'C',XDG_CONFIG_HOME:'config',HTTP_PROXY:'proxy',NODE_OPTIONS:'unsafe',LC_SECRET:'hidden',MY_API_KEY:'hidden',OTHER:'hidden'};
  assert.deepEqual(childEnvironment(env),{Path:'bin',home:'home',LC_ALL:'C',XDG_CONFIG_HOME:'config',HTTP_PROXY:'proxy'});
  assert.equal(childEnvironment(env,['my_api_key']).MY_API_KEY,'hidden');
  assert.equal(childEnvironment(env,['lc_secret']).LC_SECRET,'hidden');
});
test('a mock executable receives only permitted environment values',async()=>{
  const key='BRIDGE_TEST_API_KEY',previous=process.env[key];process.env[key]='fake-test-secret';
  try {
    for(const enabled of [false,true]){
      const child=startProcess(process.execPath,['-e',`console.log(JSON.stringify({secret:process.env.BRIDGE_TEST_API_KEY??null,nodeOptions:process.env.NODE_OPTIONS??null,path:!!process.env.PATH}))`],process.cwd(),{extraEnvPassthrough:enabled?[key]:[]});
      let output='';child.stdout!.on('data',chunk=>output+=chunk);const [code]=await once(child,'close');assert.equal(code,0);
      const result=JSON.parse(output);assert.equal(result.secret,enabled?'fake-test-secret':null);assert.equal(result.nodeOptions,null);assert.equal(result.path,true);
    }
  }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});
test('PATHEXT reaches the child so an agent shell can resolve a bare program name like git',()=>{
  assert.deepEqual(childEnvironment({Path:'bin',PATHEXT:'.COM;.EXE',PSModulePath:'x'}),{Path:'bin',PATHEXT:'.COM;.EXE'});
});
test('a parent without PATHEXT still gives a Windows child one, and one the parent set is kept',()=>{
  assert.deepEqual(withWindowsDefaults({Path:'bin'},'win32'),{Path:'bin',PATHEXT:'.COM;.EXE;.BAT;.CMD'});
  assert.deepEqual(withWindowsDefaults({Path:'bin',Pathext:'.EXE'},'win32'),{Path:'bin',Pathext:'.EXE'});
  assert.deepEqual(withWindowsDefaults({PATH:'bin'},'linux'),{PATH:'bin'});
});
