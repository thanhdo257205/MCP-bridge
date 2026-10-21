import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paths, packageRoot } from './paths.js';
import * as z from 'zod/v4';

const schema = z.object({
  allowed_workspaces: z.array(z.string()),
  executable: z.string().min(1).default('agy'),
  max_timeout_seconds: z.number().int().min(1).max(900).default(900),
  default_timeout_seconds: z.number().int().min(1).max(900).default(300),
  max_output_bytes: z.number().int().min(1024).max(1048576).default(262144),
  max_retained_tasks: z.number().int().min(1).max(200).default(50),
  max_queued_tasks: z.number().int().min(0).max(20).default(3),
  extra_env_passthrough: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100).default([]),
  prompt_transport:z.enum(['stdin','argv']).default('argv')
}).strict();
const DEFAULT_LIMITS = {max_timeout_seconds: 900, default_timeout_seconds: 300, max_output_bytes: 262144, max_retained_tasks: 50, max_queued_tasks: 3, extra_env_passthrough: [], prompt_transport:'argv'};
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
  sessionOnly = sessionWorkspaces.filter(directory => !config.allowed_workspaces.includes(directory));
  return {...config, allowed_workspaces: [...config.allowed_workspaces, ...sessionOnly]};
}
