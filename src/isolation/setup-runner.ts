import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommand } from '../antigravity/process.js';
import type { SetupCommandResult, SetupReport, SetupSpec } from './setup.js';

/**
 * Runs the owner's worktree setup commands, then becomes the agent: `node setup-runner.js <spec.json> -- <agent> <args...>`.
 *
 * It is the process the bridge launches in place of the agent, so the task's timeout, cancel and process-tree release cover the setup too,
 * and `antigravity_delegate` returns at once instead of waiting for `npm ci`. Setup output goes to stderr only: the agent's stdout is the
 * result the bridge parses. Setup commands get no stdin, so the prompt waiting on the pipe reaches the agent untouched.
 * A failed setup exits with SETUP_FAILED_EXIT and never starts the agent.
 */
const SETUP_FAILED_EXIT = 97;
const TAIL_CHARS = 4000;

function runOne(argv: string[], timeoutMs: number): Promise<SetupCommandResult> {
  return new Promise(resolve => {
    const started = Date.now();
    let tail = '';
    const keep = (chunk: Buffer) => { process.stderr.write(chunk); tail = (tail + chunk.toString('utf8')).slice(-TAIL_CHARS); };
    const done = (exit_code: number | null, signal: string | null, error?: string) =>
      resolve({command: argv, exit_code, signal, duration_ms: Date.now() - started, output_tail: error ? `${tail}\n${error}`.slice(-TAIL_CHARS) : tail});
    resolveCommand(argv[0]!).then(command => {
      let child: ChildProcess;
      try {
        child = spawn(command.executable, [...command.prefixArgs, ...argv.slice(1)], {cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      } catch (error) { done(null, null, error instanceof Error ? error.message : 'could not start'); return; }
      const timer = setTimeout(() => { tail += `\n[setup] stopped after ${Math.round(timeoutMs / 1000)}s`; child.kill('SIGKILL'); }, Math.max(1, timeoutMs));
      child.stdout!.on('data', keep);
      child.stderr!.on('data', keep);
      child.once('error', error => { clearTimeout(timer); done(null, null, error.message); });
      child.once('close', (code, signal) => { clearTimeout(timer); done(code, signal); });
    }, error => done(null, null, error instanceof Error ? error.message : 'command not found'));
  });
}

async function main(): Promise<void> {
  const [specFile, separator, agentExecutable, ...agentArgs] = process.argv.slice(2);
  if (!specFile || separator !== '--' || !agentExecutable) { process.stderr.write('[setup] usage: setup-runner <spec.json> -- <agent> [args...]\n'); process.exit(2); }
  const spec = JSON.parse(await readFile(specFile, 'utf8')) as SetupSpec;
  const started = Date.now();
  const commands: SetupCommandResult[] = [];
  let error: string | undefined;
  for (const argv of spec.commands) {
    const left = spec.timeout_ms - (Date.now() - started);
    if (left <= 0) { error = `setup did not finish within ${Math.round(spec.timeout_ms / 1000)}s`; break; }
    process.stderr.write(`[setup] ${argv.join(' ')}\n`);
    const result = await runOne(argv, left);
    commands.push(result);
    if (result.exit_code !== 0) {
      const name = `"${argv.join(' ')}"`;
      error = result.signal ? `${name} was stopped (${result.signal}); the setup time limit is ${Math.round(spec.timeout_ms / 1000)}s`
        : result.exit_code === null ? `${name} could not run: ${result.output_tail.trim().split('\n').at(-1) ?? 'unknown error'}`
        : `${name} exited ${result.exit_code}`;
      break;
    }
  }
  const report: SetupReport = {ok: !error, duration_ms: Date.now() - started, commands, ...(error ? {error} : {})};
  await writeFile(spec.report, JSON.stringify(report), {mode: 0o600});
  if (error) { process.stderr.write(`[bridge] Worktree setup failed: ${error}\n`); process.exit(SETUP_FAILED_EXIT); }

  // The agent inherits stdin (its prompt), stdout (its result) and stderr; this process only relays how it ended.
  const agent = spawn(agentExecutable, agentArgs, {cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: 'inherit'});
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { agent.kill(signal); });
  agent.once('error', failure => { process.stderr.write(`[bridge] Could not start the agent after setup: ${failure.message}\n`); process.exit(1); });
  agent.once('close', (code, signal) => {
    if (signal) { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); process.kill(process.pid, signal); }
    else process.exit(code ?? 1);
  });
}

if (path.basename(process.argv[1] ?? '').startsWith('setup-runner')) {
  main().catch(error => { process.stderr.write(`[bridge] Worktree setup could not run: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(SETUP_FAILED_EXIT); });
}
