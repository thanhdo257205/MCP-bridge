import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installSkill, skillStatus } from '../scripts/install-skill.js';

type Client = 'codex' | 'claude';
export type SkillOfferResult = 'skipped' | 'declined' | 'installed' | 'failed';

export interface SkillOfferOptions {
  stateDirectory: string; interactive: boolean; ask: (question: string) => Promise<string>;
  log?: (message: string) => void; userHome?: string; env?: NodeJS.ProcessEnv;
  install?: typeof installSkill; status?: typeof skillStatus; now?: () => number;
}

const RECORD = 'onboarding.json';
const readRecord = async (stateDirectory: string): Promise<Record<string, unknown>> => {
  try { return JSON.parse(await readFile(path.join(stateDirectory, RECORD), 'utf8')) as Record<string, unknown>; } catch { return {}; }
};
async function remember(stateDirectory: string, value: Record<string, unknown>) {
  try {
    await mkdir(stateDirectory, {recursive: true});
    await writeFile(path.join(stateDirectory, RECORD), JSON.stringify({...(await readRecord(stateDirectory)), ...value}));
  } catch { /* the record only prevents repeat questions */ }
}

/** True when the owner has opted out of start-up questions (CI, a script, or BRIDGE_NO_SKILL_PROMPT). */
export function skillPromptDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.BRIDGE_NO_SKILL_PROMPT ?? '') || /^(1|true)$/i.test(env.CI ?? '');
}

/**
 * Offers, once, to install the skills this bridge ships for Codex / Claude Code. Nothing is written without an explicit answer:
 * it only asks in an interactive terminal, only for clients that have no file yet for some skill (a customized file is never touched),
 * and the answer, including "no", is remembered so the question is not repeated. It never throws and never blocks the server.
 */
export async function offerSkillInstall(options: SkillOfferOptions): Promise<SkillOfferResult> {
  const log = options.log ?? ((message: string) => console.error(message));
  if (!options.interactive || skillPromptDisabled(options.env)) return 'skipped';
  if ((await readRecord(options.stateDirectory)).skill_offer) return 'skipped';
  let status;
  try { status = await (options.status ?? skillStatus)({userHome: options.userHome}); } catch { return 'skipped'; }
  const missing = (client: Client) => status[client].filter(entry => entry.state === 'missing');
  const clients = (['codex', 'claude'] as const).filter(client => missing(client).length > 0);
  if (!clients.length) return 'skipped';

  log('[skill] These skills tell Codex / Claude Code how to delegate to the bridge agents safely and how to review the result.');
  for (const client of clients) for (const entry of missing(client)) log(`[skill]   ${client}: ${entry.skill} would be written to ${entry.file}`);
  for (const client of ['codex', 'claude'] as const) for (const entry of status[client]) if (entry.state === 'different') log(`[skill]   ${client}: a customized ${entry.skill} skill already exists and will not be touched (${entry.file})`);
  const choices = [...clients, ...(clients.length > 1 ? ['both'] : [])].join(' / ');

  let selected: Client[] | null = null;
  for (let attempt = 0; attempt < 2 && selected === null; attempt++) {
    const answer = (await options.ask(`Install them now? [${choices} / N] `)).trim().toLowerCase();
    if (answer === '' || answer === 'n' || answer === 'no') {
      await remember(options.stateDirectory, {skill_offer: {answered_at: new Date((options.now ?? Date.now)()).toISOString(), choice: 'declined'}});
      log('[skill] Not installed, and this question will not be asked again. Install later with: agy-mcp-bridge skill install --client both');
      return 'declined';
    }
    if ((answer === 'both' || answer === 'y' || answer === 'yes') && clients.length) selected = [...clients];
    else if ((answer === 'codex' || answer === 'claude') && clients.includes(answer)) selected = [answer];
    else if (attempt === 0) log(`[skill] Please answer ${choices} or N.`);
  }
  if (!selected) return 'skipped';

  try {
    // Only the skills that are actually absent for that client: a customized file is never part of the request.
    for (const client of selected) {
      const skills = missing(client).map(entry => entry.skill);
      for (const item of await (options.install ?? installSkill)({client, userHome: options.userHome, skills})) log(`[skill] ${item.unchanged ? 'Already installed' : item.updated ? 'Updated' : 'Installed'}: ${item.filename}`);
    }
  } catch (error) {
    log(`[skill] Could not install: ${error instanceof Error ? error.message : 'unknown error'}. The server starts anyway; try again with: agy-mcp-bridge skill install --client both`);
    return 'failed';
  }
  await remember(options.stateDirectory, {skill_offer: {answered_at: new Date((options.now ?? Date.now)()).toISOString(), choice: selected.join('+')}});
  log('[skill] Reopen the client if a skill does not appear. MCP connection and workspace permissions are configured separately (agy-mcp-bridge setup).');
  return 'installed';
}

export type SkillUpdateResult = 'skipped' | 'declined' | 'updated' | 'failed';

/**
 * Offers to replace an installed skill that is an older version this project shipped. A file that matches no shipped version is the
 * owner's own edit and is neither offered nor touched. The answer, including "no", is remembered for the packaged set as it is now, so the
 * question comes back only when a newer skill ships. Same rules as the install offer: interactive terminals only, never throws.
 */
export async function offerSkillUpdate(options: SkillOfferOptions): Promise<SkillUpdateResult> {
  const log = options.log ?? ((message: string) => console.error(message));
  if (!options.interactive || skillPromptDisabled(options.env)) return 'skipped';
  let status;
  try { status = await (options.status ?? skillStatus)({userHome: options.userHome}); } catch { return 'skipped'; }
  const outdatedFor = (client: Client) => status[client].filter(entry => entry.state === 'outdated');
  const outdated = (['codex', 'claude'] as const).filter(client => outdatedFor(client).length > 0);
  if (!outdated.length) return 'skipped';
  const previous = (await readRecord(options.stateDirectory)).skill_update_offer as {hash?: unknown} | undefined;
  if (previous?.hash === status.currentHash) return 'skipped';
  const when = () => new Date((options.now ?? Date.now)()).toISOString();

  log('[skill] Newer skills ship with this bridge. These installed copies are older packaged versions (not edited by you):');
  for (const client of outdated) for (const entry of outdatedFor(client)) log(`[skill]   ${client}: ${entry.skill} at ${entry.file}`);
  let yes = false;
  for (let attempt = 0; attempt < 2 && !yes; attempt++) {
    const answer = (await options.ask('Update them now? [y / N] ')).trim().toLowerCase();
    if (answer === '' || answer === 'n' || answer === 'no') {
      await remember(options.stateDirectory, {skill_update_offer: {hash: status.currentHash, answered_at: when(), choice: 'declined'}});
      log('[skill] Not updated; this question returns only when a newer skill ships. Update any time with: agy-mcp-bridge skill install --client both --update');
      return 'declined';
    }
    if (answer === 'y' || answer === 'yes') yes = true;
    else if (attempt === 0) log('[skill] Please answer y or N.');
  }
  if (!yes) return 'skipped';
  try {
    for (const client of outdated) {
      const skills = outdatedFor(client).map(entry => entry.skill);
      for (const item of await (options.install ?? installSkill)({client, userHome: options.userHome, update: true, skills})) log(`[skill] ${item.unchanged ? 'Already up to date' : item.updated ? 'Updated' : 'Installed'}: ${item.filename}`);
    }
  } catch (error) {
    log(`[skill] Could not update: ${error instanceof Error ? error.message : 'unknown error'}. The server starts anyway; try again with: agy-mcp-bridge skill install --client both --update`);
    return 'failed';
  }
  await remember(options.stateDirectory, {skill_update_offer: {hash: status.currentHash, answered_at: when(), choice: 'updated'}});
  log('[skill] Reopen the client so it reads the updated skill.');
  return 'updated';
}
