import type { PromptTransport } from '../antigravity/invocation.js';
import { finalEnvelope, invocationFor } from '../antigravity/invocation.js';
import type { AgentAdapter, AgentCapability, AgentResult, AgentRuntime, AgentStatus, RawRun } from './types.js';

const CAPABILITIES: AgentCapability[] = ['code', 'review', 'test', 'research', 'long-run'];

export function antigravityAdapter(executable: string, transport: PromptTransport): AgentAdapter {
  return {
    id: 'antigravity',
    label: 'Antigravity',
    capabilities: CAPABILITIES,
    buildInvocation(task) {
      const invocation = invocationFor(task.prompt, task.timeoutSeconds, transport);
      return {executable, args: invocation.args, stdin: invocation.stdin};
    },
    async parseResult(raw: RawRun): Promise<AgentResult> {
      let envelope: Record<string, unknown>;
      try {
        envelope = finalEnvelope(raw.stdout, transport);
      } catch {
        throw new Error(transport === 'stdin'
          ? 'CLI output is not a valid stream-json final result. If this happens with a real agy, set "prompt_transport": "argv" in the bridge config (the previously verified mode) and restart'
          : 'CLI output is not a valid final JSON envelope');
      }
      const response = typeof envelope.response === 'string' ? envelope.response : null;
      const deniedActions = Array.isArray(envelope.denied_actions)
        ? envelope.denied_actions.slice(0, 100).map((item: unknown) => {
          const value = item as Record<string, unknown> | null;
          return {action: String(value?.action ?? 'unknown').slice(0, 200), display_name: String(value?.display_name ?? '').slice(0, 200)};
        })
        : [];
      const numTurns = typeof envelope.num_turns === 'number' ? envelope.num_turns : null;
      const result: AgentResult = {
        success: false, response, error: null,
        cliStatus: typeof envelope.status === 'string' ? envelope.status : null,
        numTurns, deniedActions
      };
      if (/print timeout|AGY_ERROR.*TIMEOUT/i.test(raw.stderr)) {
        return {...result, timeout: true, error: 'CLI reported a print timeout (possibly with exit code 0)'};
      }
      if (deniedActions.length || /auto-denied|soft.denied|permission.*cannot prompt/i.test(raw.stderr)) {
        return {...result, error: 'Required tool permissions were denied; approve a scoped rule interactively before retrying'};
      }
      if (raw.exitCode === 0 && envelope.status === 'SUCCESS' && numTurns !== null && numTurns > 0 && response?.trim()) {
        return {...result, success: true};
      }
      return {...result, error: typeof envelope.error === 'string' ? envelope.error : 'CLI did not provide a complete successful response'};
    }
  };
}

export function legacyAntigravityAgent(runtime: {
  executable: string; supported: boolean; launch?: AgentRuntime['launch'];
}, transport: PromptTransport): AgentRuntime {
  const status: AgentStatus = {
    id: 'antigravity', label: 'Antigravity', available: runtime.supported,
    version: null, executable: runtime.executable || null, capabilities: CAPABILITIES,
    warnings: runtime.supported ? [] : ['Requires agy 1.4.x and all required print/output/timeout flags']
  };
  return {adapter: antigravityAdapter(runtime.executable, transport), status, enabled: true, launch: runtime.launch};
}
