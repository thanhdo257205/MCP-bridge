import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths, packageRoot } from './paths.js';
import * as z from 'zod/v4';

export const codexSandboxSchema = z.enum(['workspace-write', 'danger-full-access', 'read-only']);
// The two policies codex-cli 0.163.0 accepts for --ask-for-approval; anything else makes codex exit before it reads the prompt.
export const codexApprovalSchema = z.enum(['on-request', 'never']);

export const agentProfileSchema = z.object({
  adapter: z.enum(['codex', 'antigravity', 'opencode']),
  label: z.string().min(1).max(100).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  codex_sandbox: codexSandboxSchema.optional(),
  codex_ask_for_approval: codexApprovalSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  executable: z.string().min(1).max(4096).optional()
}).strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const poolSchema = z.object({
  /** Has no effect: the three values it used to name all picked the first healthy member. Still accepted so a config written for it keeps loading. */
  strategy: z.string().min(1).max(64).optional(),
  members: z.array(z.string().min(1).max(64)).min(1).max(50),
  hard_task_profile: z.string().min(1).max(64).optional(),
  quota_cooldown_seconds: z.number().int().min(10).max(86400).default(900)
}).strict();
export type PoolConfig = z.infer<typeof poolSchema>;

export const xerjSchema = z.object({
  // Off unless the owner turns it on: enabling it sends task text to another local service and prepends retrieved
  // passages to the prompt an agent follows, so a search hit becomes an instruction the agent never got from the client.
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:9200'),
  default_index: z.string().default('mcp-bridge-docs'),
  auto_reference: z.boolean().default(false),
  max_passages: z.number().int().min(1).max(10).default(3)
}).strict();
export type XerjConfig = z.infer<typeof xerjSchema>;

const agentsSchema = z.object({
  codex_sandbox: codexSandboxSchema.optional(),
  codex_ask_for_approval: codexApprovalSchema.optional(),
  profiles: z.record(z.string().min(1).max(64), agentProfileSchema).optional(),
  pools: z.record(z.string().min(1).max(64), poolSchema).optional(),
  priority: z.array(z.string().min(1).max(64)).max(50).optional(),
  enabled: z.array(z.string().min(1).max(64)).max(50).optional(),
  codex_executable: z.string().min(1).max(4096).optional(),
  codex_model: z.string().min(1).max(200).optional(),
  opencode_executable: z.string().min(1).max(4096).optional(),
  opencode_model: z.string().min(1).max(200).optional()
}).strict();

const schema = z.object({
  allowed_workspaces: z.array(z.string()),
  executable: z.string().min(1).default('agy'),
  max_timeout_seconds: z.number().int().min(1).max(3600).default(900),
  default_timeout_seconds: z.number().int().min(1).max(3600).default(300),
  max_output_bytes: z.number().int().min(1024).max(1048576).default(262144),
  max_retained_tasks: z.number().int().min(1).max(200).default(50),
  max_queued_tasks: z.number().int().min(0).max(20).default(3),
  max_parallel_worktrees: z.number().int().min(1).max(8).optional(),
  default_autonomy: z.enum(['suggest', 'auto', 'full']).optional(),
  agents: agentsSchema.optional(),
  xerj: xerjSchema.optional(),
  /**
   * The process-tree watcher that runs while a task is live. One poll costs a full process-table query (about half a
   * second on the reference machine), so the cadence is owner-tunable and the whole watch can be turned off; without
   * it, a subtree whose intermediate shell exited before the agent did becomes invisible to the release.
   */
  tree_watch: z.object({
    enabled: z.boolean().optional(),
    delays_ms: z.array(z.number().int().min(100).max(60000)).min(1).max(20).optional()
  }).strict().optional(),
  extra_env_passthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100).default([]),
  prompt_transport:z.enum(['stdin','argv']).default('argv'),
  /** Longest single antigravity_task_wait call (default 55). Keep it below the MCP client's tool timeout. */
  max_wait_seconds: z.number().int().min(5).max(3600).optional()
}).strict();
const DEFAULT_LIMITS = {max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144, max_retained_tasks: 50, max_queued_tasks: 3, max_parallel_worktrees: 2, default_autonomy: 'auto', extra_env_passthrough: [], prompt_transport:'argv'};
export type Config = z.infer<typeof schema>;

// Directories allowed for this run only (agy-mcp-bridge --workspace <dir>); never written to the config file.
const sessionWorkspaces: string[] = [];
let sessionOnly: string[] = [];
export function addSessionWorkspaces(directories: string[]): void { for (const directory of directories) if (!sessionWorkspaces.includes(directory)) sessionWorkspaces.push(directory); }
/** The directories that are allowed only because of --workspace (not already in the config file). */
export function sessionOnlyWorkspaces(): string[] { return [...sessionOnly]; }
export const projectRoot = packageRoot;
export async function loadConfig(): Promise<Config> {
  const explicit = process.env.ANTIGRAVITY_BRIDGE_CONFIG;
  const filename = explicit ?? paths.configFile;
  // The local config file (config/workspaces.json in a checkout, otherwise in the user data directory) is created with an empty allowlist on first run (flag 'wx': never overwrite).
  if (!explicit) await mkdir(path.dirname(filename), {recursive: true}).then(() => writeFile(filename, JSON.stringify({allowed_workspaces: [], ...DEFAULT_LIMITS, executable: 'agy'}, null, 2) + '\n', {flag: 'wx'})).catch(() => {});
  const config = schema.parse(JSON.parse(await readFile(filename, 'utf8')));
  if (config.default_timeout_seconds > config.max_timeout_seconds) throw new Error('Default timeout exceeds maximum');
  for (const [id, pool] of Object.entries(config.agents?.pools ?? {})) {
    if (pool.strategy !== undefined) console.error(`[bridge] WARNING: agents.pools."${id}".strategy has no effect and can be removed: a pool always picks its first healthy member, in the order of "members"`);
  }
  for (const [id, profile] of Object.entries(config.agents?.profiles ?? {})) {
    if (profile.adapter === 'antigravity' && profile.model !== undefined) console.error(`[bridge] WARNING: agents.profiles."${id}".model is ignored: an antigravity profile runs with the model chosen in the web UI Settings`);
  }
  sessionOnly = sessionWorkspaces.filter(directory => !config.allowed_workspaces.includes(directory));
  return {...config, allowed_workspaces: [...config.allowed_workspaces, ...sessionOnly]};
}
