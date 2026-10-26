import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const scenario = process.argv[2];
const ok = response => process.stdout.write(JSON.stringify({status:'SUCCESS', response, num_turns:1}) + '\n');
if (scenario === 'ok') { process.stderr.write('diagnostic\n'); ok('implemented'); }
else if (scenario === 'delayed') setTimeout(()=>ok('delayed response'),500);
else if (scenario === 'fail') { process.stderr.write('error details'); process.stdout.write(JSON.stringify({status:'ERROR',error:'deliberate failure'})); process.exitCode = 7; }
else if (scenario === 'malformed') process.stdout.write('not JSON');
else if (scenario === 'partial') { process.stderr.write('[agy] print timeout after 1ms; returning partial output'); ok('partial response'); }
else if (scenario === 'empty') process.stdout.write(JSON.stringify({status:'SUCCESS',response:'',num_turns:0}));
else if (scenario === 'denied') process.stdout.write(JSON.stringify({status:'SUCCESS',response:'I could not edit the file',num_turns:1,denied_actions:[{action:'write_file',display_name:'WriteFile'}]}));
else if (scenario === 'active') {
  // Writes to the log file it was given (argv[3]) every 100 ms for argv[4] ms (default 2200), then answers: a task that is alive but slow.
  const log = process.argv[3];
  const timer = setInterval(() => { if (log) appendFileSync(log, 'tick\n'); }, 100);
  setTimeout(() => { clearInterval(timer); ok('finished while active'); }, Number(process.argv[4] ?? 2200));
}
else if (scenario === 'usage') process.stdout.write(JSON.stringify({status:'SUCCESS', response:'with usage', num_turns:2, duration_seconds:3.25, conversation_id:'c', usage:{input_tokens:1200, output_tokens:80, cache:{read_tokens:5, note:'text'}, label:'x'}}));
else if (scenario.startsWith('stream')) {
  // stream-json output as seen with probe-stream: init, step_update events, then result (without a trailing newline). stream-bad returns an
  // unexpected result; stream-many sends thousands of steps (far more than the output cap); stream-hang stops after one step and waits.
  const out = value => process.stdout.write(JSON.stringify(value) + '\n');
  out({event:'init', conversation_id:'conv-1', init:{}});
  out({event:'step_update', step_update:{type:'read_file', status:'running', path:'src/a.ts'}});
  // One event split in the middle of a multi-byte character, across two writes.
  const line = Buffer.from(JSON.stringify({event:'step_update', step_update:{type:'think', message:'đọc cấu hình ệ xong', note:'Bearer abc.def.ghi'}}) + '\n');
  const cut = line.indexOf(Buffer.from('ệ')) + 1;
  process.stdout.write(line.subarray(0, cut));
  if (scenario === 'stream-hang') { setTimeout(() => process.stdout.write(line.subarray(cut)), 50); setInterval(() => {}, 1000); }
  else setTimeout(() => {
    process.stdout.write(line.subarray(cut));
    if (scenario === 'stream-many') for (let i = 0; i < 3000; i++) out({event:'step_update', step_update:{type:'tool', n:i, text:'x'.repeat(280)}});
    out({event:'step_update', step_update:'plain string step'});
    process.stdout.write(JSON.stringify({event:'result', result: scenario === 'stream-bad' ? {something:1} : {status:'SUCCESS', response:'stream done', num_turns:1}}));
  }, 80);
}
else if (scenario === 'large') { process.stdout.write('X'.repeat(65536)); setInterval(()=>{},1000); }
else if (scenario === 'secret') { ok('Bearer abc.def.ghi api_key=supersecret'); }
else if (scenario === 'tree') {
  const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  process.stderr.write(String(child.pid)); setInterval(()=>{},1000);
}
else { process.stderr.write('waiting'); setInterval(()=>{},1000); }
