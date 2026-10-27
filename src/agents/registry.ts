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
  const known = new Set<string>([...KNOWN, ...Object.keys(settings.profiles ?? {}), ...Object.keys(settings.pools ?? {})]);
  for (const id of [...enabled, ...priority]) {
    if (!known.has(id)) warnings.push(`Unknown agent "${id}" in the bridge config is ignored`);
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
  if (settings.codex_sandbox === 'danger-full-access' || settings.codex_ask_for_approval === 'never') {
    const dangerWarn = `Agent "codex" is configured with dangerous permissions (sandbox: ${settings.codex_sandbox ?? 'workspace-write'}, approval: ${settings.codex_ask_for_approval ?? 'auto'})`;
    codexStatus.warnings.push(dangerWarn);
    warnings.push(dangerWarn);
  }
  agents.push(codexAgent(codexCommand, codexStatus, {
    model: settings.codex_model,
    sandbox: settings.codex_sandbox,
    askForApproval: settings.codex_ask_for_approval
  }));

  if (settings.profiles) {
    for (const [profileId, profile] of Object.entries(settings.profiles)) {
      const isProfileEnabled = enabled.includes(profileId) || (!settings.enabled && true);
      const adapterType = profile.adapter;
      const label = profile.label ?? (adapterType === 'codex' ? `Codex (${profileId})` : `Antigravity (${profileId})`);
      const profileWarnings: string[] = [];
      if (!isProfileEnabled) profileWarnings.push('Disabled in the bridge config');

      if (adapterType === 'antigravity') {
        let cmd = antigravity.executable;
        let prefixArgs = antigravity.prefixArgs;
        let supported = antigravity.supported;
        let version = antigravity.version;
        if (profile.executable) {
          try {
            const resolved = await resolveCommand(profile.executable);
            cmd = resolved.executable;
            prefixArgs = resolved.prefixArgs;
          } catch (error) {
            supported = false;
            profileWarnings.push(`Executable not found: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        }
        const status: AgentStatus = {
          id: profileId, label, available: isProfileEnabled && supported,
          version: version || null, executable: cmd || null,
          capabilities: ['code', 'review', 'test', 'research', 'long-run'],
          warnings: isProfileEnabled ? [...antigravity.warnings, ...profileWarnings] : profileWarnings
        };
        agents.push({
          adapter: antigravityAdapter(cmd, config.prompt_transport as PromptTransport, {id: profileId, label, env: profile.env}),
          status, enabled: isProfileEnabled, prefixArgs
        });
      } else if (adapterType === 'codex') {
        let cmd = codexCommand;
        let statusAvailable = codexStatus.available;
        let version = codexStatus.version;
        if (profile.executable) {
          try {
            cmd = await resolveCommand(profile.executable);
            const detected = await detectCodex(cmd, {cwd: process.cwd(), extraEnvPassthrough: config.extra_env_passthrough});
            statusAvailable = detected.available;
            version = detected.version;
            profileWarnings.push(...detected.warnings);
          } catch (error) {
            statusAvailable = false;
            profileWarnings.push(`Codex CLI not found: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        }
        const sandbox = profile.codex_sandbox ?? settings.codex_sandbox;
        const askForApproval = profile.codex_ask_for_approval ?? settings.codex_ask_for_approval;
        if (sandbox === 'danger-full-access' || askForApproval === 'never') {
          const dangerMsg = `Agent "${profileId}" is configured with dangerous permissions (sandbox: ${sandbox ?? 'workspace-write'}, approval: ${askForApproval ?? 'auto'})`;
          profileWarnings.push(dangerMsg);
          warnings.push(dangerMsg);
        }
        const status: AgentStatus = {
          id: profileId, label, available: isProfileEnabled && statusAvailable,
          version: version || null, executable: cmd.source || null,
          capabilities: ['code', 'review', 'test', 'research', 'long-run'],
          warnings: isProfileEnabled ? [...codexStatus.warnings.filter(w => !w.includes('Disabled') && !w.includes('dangerous permissions')), ...profileWarnings] : profileWarnings
        };
        agents.push(codexAgent(cmd, status, {
          id: profileId, label, model: profile.model ?? settings.codex_model,
          sandbox, askForApproval, env: profile.env
        }));
      }
    }
  }

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
