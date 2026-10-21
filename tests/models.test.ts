import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpBridge } from '../src/http.js';
import { TaskManager } from '../src/tasks/manager.js';
import { startProcess } from '../src/antigravity/process.js';
import { invocationFor } from '../src/antigravity/invocation.js';
import { MODEL_FILE, parseModels, readModel, validModelId, writeModel } from '../src/models.js';

const token = 'test_token_123456789012345678901234567890';
const fixture = fileURLToPath(new URL('../../tests/fixtures/fake-agy.mjs',import.meta.url));
// Real output of `agy models` (agy 1.4.x on Windows).
const SAMPLE = `gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;

test('parseModels reads `agy models` output, ignores noise and rejects unsafe ids',()=>{
  const models=parseModels(SAMPLE.replace(/\n/g,'\r\n'));
  assert.deepEqual(models.map(m=>m.id),['gemini-3.8-flash-high','gemini-3.8-flash-medium','claude-sonnet-4-6','claude-opus-4-6-thinking','gpt-oss-120b-medium']);
  assert.equal(models[2].label,'Claude Sonnet 4.6 (Thinking)');
  assert.deepEqual(parseModels('Available models:\n--evil  flag injection\nok-model  Fine\nok-model  Duplicate\n'),[{id:'ok-model',label:'Fine'}]);
  assert.deepEqual(parseModels(''),[]);
  for(const bad of ['','-x','a b','a;b','a'.repeat(101),'../x'])assert.equal(validModelId(bad),false,bad);
});
// What `agy models` printed when the bridge read it through a pipe (agy 1.4.4, Windows): a progress line first, then id<TAB>name.
const PIPED = 'Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\r\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\r\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\r\n';
test('parseModels reads the tab-separated output agy prints when piped, and ignores the progress line and color codes',()=>{
  const models=parseModels(PIPED);
  assert.deepEqual(models.map(m=>m.id),['gemini-3.8-flash-high','claude-sonnet-4-6','claude-opus-4-6-thinking','gpt-oss-120b-medium']);
  assert.equal(models[1].label,'Claude Sonnet 4.6 (Thinking)');
  assert.deepEqual(parseModels('\u001b[32mok-model\u001b[0m\tFine\n').map(m=>m.id),['ok-model']);
  assert.deepEqual(parseModels('Fetching available models...\n'),[]);
});
test('invocation adds --model only when one is chosen',()=>{
  assert.ok(!invocationFor('p',30,'argv').args.includes('--model'));
  assert.ok(!invocationFor('p',30,'argv',null).args.includes('--model'));
  const args=invocationFor('p',30,'argv','claude-sonnet-4-6').args;assert.equal(args[args.indexOf('--model')+1],'claude-sonnet-4-6');
  const stream=invocationFor('p',30,'stdin','claude-sonnet-4-6').args;assert.equal(stream[stream.indexOf('--model')+1],'claude-sonnet-4-6');
});
test('model setting round-trips, and an invalid or corrupt file means "default"',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-model-'));
  assert.equal(await readModel(dir),null);
  await writeModel(dir,'gpt-oss-120b-medium');assert.equal(await readModel(dir),'gpt-oss-120b-medium');
  await writeModel(dir,null);assert.equal(await readModel(dir),null);
  await assert.rejects(writeModel(dir,'--evil'),/Invalid model/);
  await writeFile(path.join(dir,MODEL_FILE),JSON.stringify({model:'--evil'}));assert.equal(await readModel(dir),null);
  await writeFile(path.join(dir,MODEL_FILE),'{broken');assert.equal(await readModel(dir),null);
});

async function setup(models:()=>Promise<{id:string;label:string}[]>){
  const root=await mkdtemp(path.join(tmpdir(),'agy-model-ui-'));const workspace=path.join(root,'work');await mkdir(workspace);
  const launched:string[][]=[];
  const manager=new TaskManager({allowed_workspaces:[workspace],executable:process.execPath,max_timeout_seconds:30,default_timeout_seconds:20,max_output_bytes:1024,max_retained_tasks:10,max_queued_tasks:0,extra_env_passthrough:[],prompt_transport:'argv'},
    {executable:process.execPath,supported:true,stateDirectory:path.join(root,'state'),models,launch:(args,cwd)=>{launched.push(args);return startProcess(process.execPath,[fixture,'ok'],cwd);}});
  const bridge=await startHttpBridge({manager,environment:{cli_version:'mock',allowed_workspaces:[workspace]},token,port:0});
  const api=(p:string,init:RequestInit={},session?:string)=>fetch(`${bridge.baseUrl}/ui/api/${p}`,{...init,headers:{...(init.body?{'Content-Type':'application/json'}:{}),...(session?{'X-Bridge-Session':session}:{})}});
  const session=String(((await (await api('login',{method:'POST',body:JSON.stringify({token})})).json()) as {session:string}).session);
  return {manager,bridge,api,session,workspace,launched};
}

test('web UI: the chosen model is validated against `agy models`, applies to new tasks and is recorded on them',async()=>{
  const {manager,bridge,api,session,workspace,launched}=await setup(async()=>parseModels(SAMPLE));
  try {
    assert.deepEqual(await (await api('models',{},session)).json(),{models:parseModels(SAMPLE),current:null});
    assert.equal((await api('models')).status,401);
    assert.equal((await api('model',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6'})})).status,401);
    for(const model of ['nope-model','--evil',42,undefined])assert.equal((await api('model',{method:'POST',body:JSON.stringify({model})},session)).status,400,String(model));
    const before=await manager.delegate({task:'t1',workspace,acceptance_criteria:['x']});await manager.waitFor(before.task_id,10);
    assert.ok(!launched[0].includes('--model'));assert.equal(manager.detail(before.task_id).request?.model,null);
    assert.equal((await api('model',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6'})},session)).status,200);
    assert.equal((await (await api('overview',{},session)).json() as {model:string}).model,'claude-sonnet-4-6');
    const after=await manager.delegate({task:'t2',workspace,acceptance_criteria:['x']});await manager.waitFor(after.task_id,10);
    assert.equal(launched[1][launched[1].indexOf('--model')+1],'claude-sonnet-4-6');
    assert.equal(manager.detail(after.task_id).request?.model,'claude-sonnet-4-6');
    assert.equal(manager.detail(before.task_id).request?.model,null,'earlier tasks keep what they ran with');
    assert.equal((await api('model',{method:'POST',body:JSON.stringify({model:null})},session)).status,200);
    assert.equal((await (await api('overview',{},session)).json() as {model:null}).model,null);
  } finally {await bridge.close();}
});
test('web UI: when `agy models` fails the list is empty with an error and a choice is refused',async()=>{
  const {bridge,api,session}=await setup(async()=>{throw new Error('`agy models` did not return a model list');});
  try {
    const listed=await (await api('models',{},session)).json() as {models:unknown[];error?:string};
    assert.deepEqual(listed.models,[]);assert.match(String(listed.error),/agy models/);
    assert.equal((await api('model',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6'})},session)).status,409);
    assert.equal((await api('model',{method:'POST',body:JSON.stringify({model:null})},session)).status,200,'going back to the default never needs the list');
  } finally {await bridge.close();}
});
