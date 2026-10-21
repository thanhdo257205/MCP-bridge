import { existsSync } from 'node:fs';
import path from 'node:path';

export interface DelegationState { enabled: boolean; reason: string | null; }
export const SWITCH_FILE = 'delegation.off';

/**
 * Owner-controlled kill switch for new delegations, checked on every call so no restart is needed.
 * Disabled by BRIDGE_DELEGATION=off, by any value other than on/off (fail closed), or by the switch file
 * `.bridge-state/delegation.off` (see `npm run delegation`). Existing tasks stay queryable and cancelable.
 */
export function delegationState(stateDirectory: string, env: NodeJS.ProcessEnv = process.env): DelegationState {
  const value = env.BRIDGE_DELEGATION?.trim().toLowerCase();
  if (value === 'off') return {enabled: false, reason: 'BRIDGE_DELEGATION=off'};
  if (value !== undefined && value !== '' && value !== 'on') return {enabled: false, reason: 'BRIDGE_DELEGATION has an invalid value (use on or off)'};
  if (existsSync(path.join(stateDirectory, SWITCH_FILE))) return {enabled: false, reason: 'delegation switched off with `npm run delegation -- off`'};
  return {enabled: true, reason: null};
}
