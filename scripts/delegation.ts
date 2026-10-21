import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SWITCH_FILE, delegationState } from '../src/delegation.js';

// Local, immediate switch for whether the running bridge accepts new delegations. No restart, no token needed.
const stateDirectory = fileURLToPath(new URL('../../.bridge-state/', import.meta.url));
const file = path.join(stateDirectory, SWITCH_FILE);
const command = process.argv[2];
if (command === 'off') {
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(file, `${new Date().toISOString()}\n`);
} else if (command === 'on') {
  await rm(file, {force: true});
} else if (command !== 'status') {
  console.error('Usage: npm run delegation -- on|off|status');
  process.exit(2);
}
const state = delegationState(stateDirectory);
console.log(state.enabled ? 'Delegation to Antigravity: ENABLED' : `Delegation to Antigravity: DISABLED (${state.reason})`);
console.log('Tasks already running are not stopped; use antigravity_cancel_task for those.');
if (command === 'on' && !state.enabled) process.exitCode = 1;
