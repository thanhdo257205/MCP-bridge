import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export function validateToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('BRIDGE_HTTP_TOKEN must contain 32-256 URL-safe characters');
  return value;
}
export async function loadHttpToken(stateDirectory: string): Promise<{token: string; source: string}> {
  if (process.env.BRIDGE_HTTP_TOKEN !== undefined) return {token: validateToken(process.env.BRIDGE_HTTP_TOKEN), source: 'BRIDGE_HTTP_TOKEN'};
  await mkdir(stateDirectory, {recursive: true});
  const filename = path.join(stateDirectory, 'http-token');
  try { await writeFile(filename, randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if ((await lstat(filename)).isSymbolicLink()) throw new Error('HTTP token file must not be a symlink');
  return {token: validateToken((await readFile(filename, 'utf8')).trim()), source: filename};
}
export function tokensEqual(supplied: string, token: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function authorized(header: string | undefined, token: string): boolean {
  return Boolean(header?.startsWith('Bearer ')) && tokensEqual(header!.slice(7), token);
}
