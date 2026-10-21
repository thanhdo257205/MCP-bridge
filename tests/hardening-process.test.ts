import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {startProcess, terminateOwned, TERMINATION_GRACE_MS} from '../src/antigravity/process.js';

test('POSIX termination allows SIGTERM cleanup before escalating', {skip:process.platform==='win32'}, async () => {
  const child=startProcess(process.execPath,['-e',`process.on('SIGTERM',()=>{console.log('cleaned');process.exit(0)});console.log('ready');setInterval(()=>{},1000)`],process.cwd());
  let output='';child.stdout!.on('data',chunk=>output+=chunk);
  while(!output.includes('ready'))await once(child.stdout!,'data');
  const closed=once(child,'close');await terminateOwned(child);const [code,signal]=await closed;
  assert.equal(code,0);assert.equal(signal,null);assert.match(output,/cleaned/);
});
test('POSIX termination escalates an unresponsive owned group after eight seconds', {skip:process.platform==='win32'}, async () => {
  const child=startProcess(process.execPath,['-e',`process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)`],process.cwd());
  await once(child.stdout!,'data');const closed=once(child,'close');const started=Date.now();
  await Promise.all([terminateOwned(child),terminateOwned(child)]);
  const [,signal]=await closed;assert.equal(signal,'SIGKILL');assert.ok(Date.now()-started>=TERMINATION_GRACE_MS-50);
});
