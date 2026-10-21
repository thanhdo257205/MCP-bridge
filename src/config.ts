import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';

const schema = z.object({
  allowed_workspaces: z.array(z.string()),
  executable: z.string().min(1).default('agy'),
  max_timeout_seconds: z.number().int().min(1).max(900).default(900),
  default_timeout_seconds: z.number().int().min(1).max(900).default(300),
  max_output_bytes: z.number().int().min(1024).max(1048576).default(262144),
  max_retained_tasks: z.number().int().min(1).max(200).default(50)
}).strict();
export type Config = z.infer<typeof schema>;
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function loadConfig(): Promise<Config> {
  const filename = process.env.ANTIGRAVITY_BRIDGE_CONFIG ?? fileURLToPath(new URL('../../config/workspaces.json', import.meta.url));
  const config = schema.parse(JSON.parse(await readFile(filename, 'utf8')));
  if (config.default_timeout_seconds > config.max_timeout_seconds) throw new Error('Default timeout exceeds maximum');
  return config;
}
