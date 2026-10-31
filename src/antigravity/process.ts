import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inside } from '../security/workspace.js';

export interface ResolvedCommand { executable: string; prefixArgs: string[]; source: string; }

/** Patch releases exercised with a real agent run; other 1.4.x patches still run but warn. */
export const VERIFIED_AGY_VERSIONS = ['1.4.3', '1.4.7', '1.4.8', '1.4.9'] as const;

/**
 * Resolve a command without ever going through a shell. On Windows an npm-installed CLI is usually a `.cmd`
 * shim; spawning it with shell:false fails, and spawning it through cmd.exe would allow argument injection.
 * A shim is accepted only when it points at a local `.js` entry inside the shim's own directory, which is then
 * run with the current Node binary.
 */
export async function resolveCommand(configured: string): Promise<ResolvedCommand> {
  if (!configured || configured.includes('\0')) throw new Error('Command name is invalid');
  const bases = path.isAbsolute(configured) ? [configured] :
    (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, configured));
  const candidates = bases.flatMap(base => process.platform === 'win32' && !path.extname(base)
    ? [`${base}.exe`, base, `${base}.cmd`, `${base}.bat`] : [base]);
  for (const candidate of candidates) {
    let resolved: string;
    try {
      await access(candidate);
      resolved = await realpath(candidate);
    } catch { continue; /* Try the next PATH entry. */ }
    const extension = path.extname(resolved).toLowerCase();
    // A shim that exists but cannot be resolved safely is a definitive failure: silently falling through
    // to the next PATH entry would hide why the configured command cannot run.
    if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
      const entry = await shimEntry(resolved);
      // A shim of a natively packaged CLI (OpenCode) points at its own .exe: run that directly, not through Node.
      if (path.extname(entry).toLowerCase() === '.exe') return {executable: entry, prefixArgs: [], source: resolved};
      return {executable: process.execPath, prefixArgs: [entry], source: resolved};
    }
    if (process.platform === 'win32' && extension !== '.exe') continue;
    return {executable: resolved, prefixArgs: [], source: resolved};
  }
  throw new Error(`Command not found: ${configured}${process.platform === 'win32' ? ' (a native .exe or an npm .cmd shim pointing at a local .js or .exe entry is required)' : ''}`);
}

const SHIM_ENTRY = /(?:%dp0%|%~dp0)[\\/]([^"\r\n]+?\.(?:js|mjs|cjs|exe))/gi;
async function shimEntry(shim: string): Promise<string> {
  const text = await readFile(shim, 'utf8');
  if (text.length > 65536) throw new Error('Unsupported .cmd shim: file is too large');
  const directory = path.dirname(shim);
  for (const match of text.matchAll(SHIM_ENTRY)) {
    const candidate = path.resolve(directory, match[1]);
    if (!inside(directory, candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      if (!inside(await realpath(directory), resolved)) continue;
      await access(resolved);
      return resolved;
    } catch { /* Try another entry in the shim. */ }
  }
  throw new Error('Unsupported .cmd shim: no local .js entry found');
}

/** Resolves the executable only. Use resolveCommand when the command may be a Windows shim with a script prefix. */
export async function findExecutable(configured: string): Promise<string> {
  return (await resolveCommand(configured)).executable;
}

export function childEnvironment(parent:NodeJS.ProcessEnv, extra:string[]=[]):NodeJS.ProcessEnv {
  const explicit=new Set(extra.map(key=>key.toUpperCase()));
  const base=/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SYSTEMROOT|COMSPEC|LANG|LC_.*|XDG_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  return Object.fromEntries(Object.entries(parent).filter(([key,value])=>value!==undefined&&
    (explicit.has(key.toUpperCase())||(base.test(key)&&!/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)))));
}
export interface ProcessOptions {extraEnvPassthrough?:string[];stdin?:string;customEnv?:Record<string,string>;}
export function startProcess(executable: string, args: string[], cwd: string, options:ProcessOptions={}): ChildProcess {
  const env = {...childEnvironment(process.env,options.extraEnvPassthrough),...(options.customEnv??{})};
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

/** Probes a resolved command. The whole command goes in, not just its executable: a Windows shim runs as
 * `node <script>` and asking `node --version` would report Node's version instead of the CLI's. */
export async function inspectCli(command: ResolvedCommand, cwd: string, run: typeof startProcess = startProcess, requireStdin=false) {
  const capture = (args: string[]) => new Promise<{code: number | null; text: string}>((resolve, reject) => {
    const child = run(command.executable, [...command.prefixArgs, ...args], cwd);
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
  const verified = (VERIFIED_AGY_VERSIONS as readonly string[]).includes(actual);
  const warnings=supported&&!verified?[`agy ${actual} is compatible by 1.4.x version/help checks, but only ${VERIFIED_AGY_VERSIONS.join(' and ')} have been verified with real agent execution`]:[];
  return { version: actual, supported, executable: command.executable, prefixArgs: command.prefixArgs, warnings };
}
