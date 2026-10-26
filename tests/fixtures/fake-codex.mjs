import { writeFile } from 'node:fs/promises';

// Mimics `codex exec --json`: JSONL events on stdout and the final message in the `-o` file.
const args = process.argv.slice(2);
const [scenario = 'ok', target = 'agent.txt', delay = '0'] = args;
const outputIndex = args.findIndex(arg => arg === '-o' || arg === '--output-last-message');
const resultFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
let scopedTarget = null;
try {
  const taskData = JSON.parse(prompt.trim().split(/\r?\n/).at(-1));
  if (Array.isArray(taskData.owns) && taskData.owns.length) scopedTarget = taskData.owns[0];
} catch { /* not a bridge prompt */ }
const destination = target === 'scope' ? scopedTarget ?? target : target;
const event = value => process.stdout.write(`${JSON.stringify(value)}\n`);

event({type: 'thread.started', thread_id: 'fake-thread'});
if (!prompt.trim()) {
  event({type: 'error', message: 'missing prompt on stdin'});
  process.exitCode = 9;
} else if (scenario === 'fail') {
  event({type: 'error', message: 'deliberate codex failure'});
  process.exitCode = 3;
} else if (scenario === 'denied') {
  event({type: 'item.completed', item: {type: 'command_execution', status: 'declined', command: 'rm -rf build'}});
  if (resultFile) await writeFile(resultFile, 'blocked by approval policy\n');
} else if (scenario === 'write') {
  await new Promise(resolve => setTimeout(resolve, Number(delay) || 0));
  await writeFile(destination, 'edited by codex\n');
  event({type: 'turn.completed', status: 'completed'});
  event({type: 'item.completed', item: {type: 'agent_message', text: `wrote ${destination}`}});
  if (resultFile) await writeFile(resultFile, `wrote ${destination}\n`);
} else {
  event({type: 'turn.completed', status: 'completed'});
  event({type: 'item.completed', item: {type: 'agent_message', text: 'codex implemented from JSONL'}});
  if (resultFile) await writeFile(resultFile, 'codex implemented\n');
}
