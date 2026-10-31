// Mimics `opencode run --format json` as measured on v2.2.5 (docs/APPROVAL-QUEUE-PLAN.md section 2.3): one JSON event per line on stdout.
// `denied`: the run asked for a shell permission, was auto-rejected because it cannot ask, and carried on to a final answer.
const scenario = process.argv[2] ?? 'ok';
for await (const chunk of process.stdin) void chunk; // the prompt arrives on stdin
const event = (type, part) => process.stdout.write(`${JSON.stringify({type, timestamp: Date.now(), sessionID: 'ses_fake', part})}\n`);

event('step_start', {type: 'step-start'});
if (scenario === 'denied') {
  event('tool_use', {type: 'tool', tool: 'shell', state: {
    status: 'error', input: {command: 'echo IN_OK > inside.txt'},
    error: 'This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.'
  }});
  process.stderr.write('! permission requested: shell (echo IN_OK > inside.txt); auto-rejecting\n');
  event('text', {type: 'text', text: 'I could not create the file: the shell permission was rejected.'});
} else {
  event('tool_use', {type: 'tool', tool: 'shell', state: {status: 'completed', input: {command: 'echo IN_OK > inside.txt'}, output: 'IN_OK'}});
  event('text', {type: 'text', text: 'DONE'});
}
event('step_finish', {type: 'step-finish', reason: 'stop', tokens: {input: 12, output: 4}});
