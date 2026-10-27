import { readFileSync } from 'node:fs';
import { MissionManager } from '../src/missions/missions.js';
import type { TaskManager } from '../src/tasks/manager.js';

// Tests that are not about missions still have to hand the HTTP bridge a plan store; it only needs to accept the
// workspace the task manager was given, and the same timeout ceiling the manager enforces.
export function missionsFor(manager: TaskManager, workspace = '', maxTimeoutSeconds = 30): MissionManager {
  return new MissionManager(manager, {allowed_workspaces: workspace ? [workspace] : [], max_timeout_seconds: maxTimeoutSeconds});
}

// A killed child whose parent never reaped it (common in containers without an init process) still answers kill(pid, 0).
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

// SIGKILL is delivered asynchronously and the orphan is reaped by init later, so poll briefly instead of asserting at once.
export async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}
