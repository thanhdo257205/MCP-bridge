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

export function startProcess(executable: string, args: string[], cwd: string): ChildProcess {
  const env = {...process.env};
  delete env.BRIDGE_HTTP_TOKEN;
  const child = spawn(executable, args, {
    cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin!.end();
  return child;
}

// The child handle must still be live. Never select processes by executable name.
export async function terminateOwned(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(path.join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(new Error('Owned process tree could not be terminated')));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export async function inspectCli(executable: string, cwd: string) {
  const capture = (args: string[]) => new Promise<{code: number | null; text: string}>((resolve, reject) => {
    const child = startProcess(executable, args, cwd);
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
  const supported = version.code === 0 && version.text.trim() === '1.4.3' && help.code === 0 &&
    ['--print', '--output-format', '--print-timeout', '--disable-slash-commands'].every(flag => help.text.includes(flag));
  return { version: version.text.trim(), supported, executable };
}
