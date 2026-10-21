import { paths } from '../src/paths.js';
import { delegationState, setDelegationSwitch } from '../src/delegation.js';

// Local, immediate switch for whether the running bridge accepts new delegations. No restart, no token needed.
const stateDirectory = paths.stateDirectory;
const command = process.argv[2];
if (command === 'off') await setDelegationSwitch(stateDirectory, false);
else if (command === 'on') await setDelegationSwitch(stateDirectory, true);
else if (command !== 'status') {
  console.error('Usage: agy-mcp-bridge delegation on|off|status (npm run delegation -- on|off|status in a git checkout)');
  process.exit(2);
}
const state = delegationState(stateDirectory);
console.log(state.enabled ? 'Delegation to Antigravity: ENABLED' : `Delegation to Antigravity: DISABLED (${state.reason})`);
console.log('Tasks already running are not stopped; use antigravity_cancel_task for those.');
if (command === 'on' && !state.enabled) process.exitCode = 1;
