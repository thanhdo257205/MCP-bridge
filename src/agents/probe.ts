import { startProcess, terminateOwned, type ResolvedCommand } from '../antigravity/process.js';

export interface Capture { code: number | null; text: string; }

/**
 * Runs an agent CLI once to read its output (`--version`, `<subcommand> --help`) while it is being inspected. Bounded in time (10 s) and in
 * size (32 KiB of combined stdout and stderr), and the process is killed with its tree when the time runs out. `label` names the CLI in the error.
 */
export function captureOutput(label: string, command: ResolvedCommand, args: string[], cwd: string, extraEnvPassthrough: string[]): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = startProcess(command.executable, [...command.prefixArgs, ...args], cwd, {extraEnvPassthrough});
    let text = '';
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; void terminateOwned(child).catch(reject); }, 10000);
    const append = (chunk: Buffer) => { if (text.length < 32768) text += chunk.toString().slice(0, 32768 - text.length); };
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); exceeded ? reject(new Error(`${label} inspection timed out`)) : resolve({code, text}); });
  });
}
