import { readFileSync } from 'node:fs';

// A killed child whose parent never reaped it (common in containers without an init process) still answers kill(pid, 0).
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}
