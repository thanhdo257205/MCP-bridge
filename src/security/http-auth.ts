import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
type AclRunner=(file:string,args:string[])=>Promise<{stdout:string}>;
export async function hardenWindowsToken(filename:string, options:{platform?:NodeJS.Platform;run?:AclRunner;warn?:(message:string)=>void}={}) {
  if((options.platform??process.platform)!=='win32')return;
  const run:AclRunner=options.run??(async(file,args)=>execFileAsync(file,args,{shell:false,windowsHide:true,encoding:'utf8',timeout:5000}));
  try {
    const system=path.join(process.env.SystemRoot??'C:/Windows','System32');
    const identity=await run(path.join(system,'whoami.exe'),['/user','/fo','csv','/nh']);
    const sid=identity.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
    if(!sid)throw new Error('Current user SID unavailable');
    await run(path.join(system,'icacls.exe'),[filename,'/inheritance:r','/grant:r',`*${sid}:(R,W)`]);
  }catch{(options.warn??console.error)('[bridge] WARNING: Windows token ACL could not be restricted; secure the token file manually.');}
}

export function validateToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('BRIDGE_HTTP_TOKEN must contain 32-256 URL-safe characters');
  return value;
}
export async function loadHttpToken(stateDirectory: string): Promise<{token: string; source: string}> {
  if (process.env.BRIDGE_HTTP_TOKEN !== undefined) return {token: validateToken(process.env.BRIDGE_HTTP_TOKEN), source: 'BRIDGE_HTTP_TOKEN'};
  await mkdir(stateDirectory, {recursive: true});
  const filename = path.join(stateDirectory, 'http-token');
  let created=false;
  try { await writeFile(filename, randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600});created=true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if ((await lstat(filename)).isSymbolicLink()) throw new Error('HTTP token file must not be a symlink');
  const token=validateToken((await readFile(filename,'utf8')).trim());
  if(created)await hardenWindowsToken(filename);
  return {token, source: filename};
}
export function tokensEqual(supplied: string, token: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function authorized(header: string | undefined, token: string): boolean {
  return Boolean(header?.startsWith('Bearer ')) && tokensEqual(header!.slice(7), token);
}
