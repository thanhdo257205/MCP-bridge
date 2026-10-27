import type { PoolConfig } from '../config.js';

export const QUOTA_ERROR_PATTERNS = [
  /insufficient_quota/i,
  /rate[_\s-]?limit(?:ed|_exceeded)?/i,
  /quota[_\s-]?exceeded/i,
  /credits?[_\s-]?exhausted/i,
  /check your plan and billing/i,
  /billing details/i,
  /too many requests/i,
  /credit limit/i,
  /model[_\s-]?capacity/i,
  /\boverloaded\b/i,
  /exceeded your current quota/i,
  /resource_exhausted/i,
  /\b429\b/
];

/** Check if stdout/stderr/error text indicates an account quota exhaustion or rate limit. */
export function isQuotaError(text: string): boolean {
  if (!text) return false;
  return QUOTA_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

const HARD_KEYWORDS = /(?:refactor|architecture|concurrency|tái cấu trúc|bảo mật|tối ưu|redesign|deadlock|race condition|migration|distributed)/i;

export interface TaskComplexityInput {
  task?: string;
  context?: string | null;
  owns?: string[];
  acceptance_criteria?: string[];
  timeout_seconds?: number;
  effort?: string;
}

/** Assess whether a task is considered 'hard' (high complexity, multi-file, or architectural). */
export function isHardTask(input: TaskComplexityInput): boolean {
  if ((input.owns?.length ?? 0) >= 3) return true;
  if ((input.acceptance_criteria?.length ?? 0) >= 4) return true;
  const fullText = `${input.task ?? ''} ${input.context ?? ''}`;
  if (fullText.length >= 3000) return true;
  if (HARD_KEYWORDS.test(fullText)) return true;
  if ((input.timeout_seconds ?? 0) >= 600) return true;
  if (input.effort === 'high') return true;
  return false;
}

export class ProfileHealthTracker {
  private cooldowns = new Map<string, number>();

  /** Mark a profile as exhausted / in cooldown until now + durationSeconds. */
  markCooldown(profileId: string, durationSeconds = 900): void {
    const expiresAt = Date.now() + durationSeconds * 1000;
    this.cooldowns.set(profileId, expiresAt);
  }

  /** Check if a profile is currently available (not cooled down). */
  isAvailable(profileId: string): boolean {
    const expiresAt = this.cooldowns.get(profileId);
    if (!expiresAt) return true;
    if (Date.now() >= expiresAt) {
      this.cooldowns.delete(profileId);
      return true;
    }
    return false;
  }

  /** Clear cooldown for testing or explicit manual recovery. */
  clearCooldown(profileId: string): void {
    this.cooldowns.delete(profileId);
  }

  /**
   * Intelligently select the best profile from a pool based on task difficulty and health status.
   * Never returns a member listed in `exclude` (already tried this task) or currently in cooldown.
   * Returns null when nothing healthy remains — callers must fail the task rather than loop.
   */
  selectProfile(
    pool: PoolConfig,
    isHard: boolean,
    isAgentAvailable: (id: string) => boolean,
    exclude: ReadonlySet<string> = new Set()
  ): string | null {
    const usableMembers = pool.members.filter(id => isAgentAvailable(id) && !exclude.has(id));
    if (!usableMembers.length) return null;

    const healthyMembers = usableMembers.filter(id => this.isAvailable(id));
    if (!healthyMembers.length) return null;

    if (isHard && pool.hard_task_profile && healthyMembers.includes(pool.hard_task_profile)) {
      return pool.hard_task_profile;
    }

    // 'quota-adaptive', 'priority-failover', and the current round-robin stub: first healthy in pool order
    return healthyMembers[0];
  }
}

export const globalHealthTracker = new ProfileHealthTracker();
