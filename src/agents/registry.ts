import type { Config } from '../config.js';
import { resolveCommand, type ResolvedCommand } from '../antigravity/process.js';
import type { PromptTransport } from '../antigravity/invocation.js';
import { antigravityAdapter } from './antigravity.js';
import { codexAgent, detectCodex } from './codex.js';
import type { AgentRuntime, AgentStatus, PublicAgentStatus } from './types.js';

export interface AntigravityInspection {
  executable: string; supported: boolean; version: string; warnings: string[];
  /** The resolved .js entry of a Windows shim; the adapter's args follow it, so the launch needs them too. */
  prefixArgs?: string[];
}

export interface AgentRegistry {
  agents: AgentRuntime[];
  defaultAgent: string | null;
  warnings: string[];
}

const KNOWN = ['antigravity', 'codex'] as const;
const DEFAULT_PRIORITY = ['antigravity', 'codex'];
const DEFAULT_ENABLED = ['antigravity', 'codex'];

export async function createAgentRegistry(config: Config, antigravity: AntigravityInspection): Promise<AgentRegistry> {
  const settings = config.agents ?? {};
  const enabled = settings.enabled ?? DEFAULT_ENABLED;
  const priority = settings.priority ?? DEFAULT_PRIORITY;
  const warnings: string[] = [];
  for (const id of [...enabled, ...priority]) {
    if (!(KNOWN as readonly string[]).includes(id)) warnings.push(`Unknown agent "${id}" in the bridge config is ignored`);
  }
  const agents: AgentRuntime[] = [];

  const antigravityEnabled = enabled.includes('antigravity');
  const antigravityStatus: AgentStatus = {
    id: 'antigravity', label: 'Antigravity', available: antigravityEnabled && antigravity.supported,
    version: antigravity.version || null, executable: antigravity.executable || null,
    capabilities: ['code', 'review', 'test', 'research', 'long-run'],
    warnings: antigravityEnabled ? antigravity.warnings : ['Disabled in the bridge config']
  };
  agents.push({
    adapter: antigravityAdapter(antigravity.executable, config.prompt_transport as PromptTransport),
    status: antigravityStatus, enabled: antigravityEnabled, prefixArgs: antigravity.prefixArgs
  });

  const codexEnabled = enabled.includes('codex');
  let codexStatus: AgentStatus = {
    id: 'codex', label: 'Codex', available: false, version: null, executable: null,
    capabilities: ['code', 'review', 'test', 'research', 'long-run'], warnings: ['Disabled in the bridge config']
  };
  let codexCommand: ResolvedCommand = {executable: 'codex', prefixArgs: [], source: 'codex'};
  if (codexEnabled) {
    try {
      codexCommand = await resolveCommand(settings.codex_executable ?? 'codex');
      codexStatus = await detectCodex(codexCommand, {cwd: process.cwd(), extraEnvPassthrough: config.extra_env_passthrough});
    } catch (error) {
      codexStatus = {...codexStatus, warnings: [`Codex CLI not found: ${error instanceof Error ? error.message : 'unknown error'}`]};
    }
  }
  agents.push(codexAgent(codexCommand, codexStatus, {model: settings.codex_model}));

  const usable = (agent: AgentRuntime) => agent.enabled && agent.status.available;
  const defaultAgent = priority.find(id => agents.some(agent => agent.adapter.id === id && usable(agent)))
    ?? agents.find(usable)?.adapter.id ?? null;
  return {agents, defaultAgent, warnings};
}

export function publicAgents(agents: AgentRuntime[]): PublicAgentStatus[] {
  return agents.map(({adapter, status, enabled}) => ({
    id: adapter.id, label: adapter.label, enabled, available: status.available,
    version: status.version, executable: status.executable, capabilities: adapter.capabilities, warnings: status.warnings
  }));
}
