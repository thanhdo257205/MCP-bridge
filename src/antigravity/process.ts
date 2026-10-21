import { spawn, type ChildProcess } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function findExecutable(configured: string): Promise<string> {
  const candidates = path.isAbsolute(configured) ? [configured] :
    (process.env.PATH ?? '').split(path.delimiter).flatMap(dir =>
      process.platform === 'win32' ? [path.join(dir, `${configured}.exe`), path.join(dir, configured)] : [path.join(dir, configured)]);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const resolved = await realpath(candidate);
      if (process.platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') continue;
      return resolved;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Antigravity executable not found (Windows requires a native .exe)');
}

export function childEnvironment(parent:NodeJS.ProcessEnv, extra:string[]=[]):NodeJS.ProcessEnv {
  const explicit=new Set(extra.map(key=>key.toUpperCase()));
  const base=/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|COMSPEC|LANG|LC_.*|XDG_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  return Object.fromEntries(Object.entries(parent).filter(([key,value])=>value!==undefined&&
    (explicit.has(key.toUpperCase())||(base.test(key)&&!/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)))));
}
export interface ProcessOptions {extraEnvPassthrough?:string[];stdin?:string;}
export function startProcess(executable: string, args: string[], cwd: string, options:ProcessOptions={}): ChildProcess {
  const env = childEnvironment(process.env,options.extraEnvPassthrough);
  const child = spawn(executable, args, {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin!.on('error',error=>{
    if(!['EPIPE','ERR_STREAM_DESTROYED'].includes((error as NodeJS.ErrnoException).code??''))child.emit('error',error);
  });
  child.stdin!.end(options.stdin);
  return child;
}

const terminations = new WeakMap<ChildProcess, Promise<void>>();
export const TERMINATION_GRACE_MS = 8000;
// Never select processes by name. Concurrent timeout/cancel requests share one termination.
export function terminateOwned(child: ChildProcess): Promise<void> {
  const existing = terminations.get(child);
  if (existing) return existing;
  const result = terminate(child);
  terminations.set(child, result);
  return result;
}
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(path.join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(new Error('Owned process tree could not be terminated')));
    });
  } else {
    const signal = (value: NodeJS.Signals | 0) => {
      try { process.kill(-child.pid!, value); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    };
    if (!signal('SIGTERM')) return;
    const deadline = Date.now() + TERMINATION_GRACE_MS;
    while (signal(0)) {
      if (Date.now() >= deadline) { signal('SIGKILL'); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function inspectCli(executable: string, cwd: string, run: typeof startProcess = startProcess, requireStdin=false) {
  const capture = (args: string[]) => new Promise<{code: number | null; text: string}>((resolve, reject) => {
    const child = run(executable, args, cwd);
    let text = '';
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; void terminateOwned(child).catch(reject); }, 10000);
    const capture = (chunk: Buffer) => { if (text.length < 32768) text += chunk.toString().slice(0, 32768 - text.length); };
    child.stdout!.on('data', capture);
    // Go-style help may be written to stderr even when the command exits 0.
    child.stderr!.on('data', capture);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); exceeded ? reject(new Error('CLI inspection timed out')) : resolve({code, text}); });
  });
  const version = await capture(['--version']);
  const help = await capture(['--help']);
  const actual=version.text.trim();
  const supported = version.code === 0 && /^1\.4\.\d+$/.test(actual) && help.code === 0 &&
    ['--print', '--output-format', '--print-timeout', '--disable-slash-commands',...(requireStdin?['--input-format']:[])].every(flag => new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`).test(help.text));
  const warnings=supported&&actual!=='1.4.3'?[`agy ${actual} is compatible by 1.4.x version/help checks, but only 1.4.3 has been verified with real agent execution`]:[];
  return { version: actual, supported, executable, warnings };
}
