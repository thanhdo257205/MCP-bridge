import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PoolConfig } from '../config.js';

/**
 * Wording that is hard to meet in ordinary prose or code: a provider says it, an agent rarely writes it by accident.
 * These are the only patterns trusted on stdout, where an agent's own message ("I fixed the rate limit handler") lives.
 */
export const STRONG_QUOTA_PATTERNS = [
  /insufficient_quota/i,
  /quota[_\s-]?exceeded/i,
  /credits?[_\s-]?exhausted/i,
  /check your plan and billing/i,
  /exceeded your current quota/i,
  /resource_exhausted/i
];

/** Everything above, plus wording that error text uses but prose and stack traces also do. Only for stderr and the CLI's own error field. */
export const QUOTA_ERROR_PATTERNS = [
  ...STRONG_QUOTA_PATTERNS,
  /rate[_\s-]?limit(?:ed|_exceeded)?/i,
  /billing details/i,
  /too many requests/i,
  /credit limit/i,
  /model[_\s-]?capacity/i,
  /\boverloaded\b/i,
  // A bare 429 also matches line numbers (`parser.ts:429`) and counts, so it has to be named as a status.
  /\b(?:http|status|code|error)\b[^\n]{0,20}\b429\b/i,
  /\b429\s+(?:too many|rate|error|client error)/i
];

/** Check if stderr or a CLI error field indicates an account quota exhaustion or rate limit. */
export function isQuotaError(text: string): boolean {
  if (!text) return false;
  return QUOTA_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

/** The stricter check for stdout, which carries the agent's own words as well as the CLI's output. */
export function isStrongQuotaError(text: string): boolean {
  if (!text) return false;
  return STRONG_QUOTA_PATTERNS.some(pattern => pattern.test(text));
}

const HARD_KEYWORDS = /(?:refactor|architecture|concurrency|tái cấu trúc|bảo mật|tối ưu|redesign|deadlock|race condition|migration|distributed)/i;

export interface TaskComplexityInput {
  task?: string;
  context?: string | null;
  owns?: string[];
  acceptance_criteria?: string[];
  timeout_seconds?: number;
}

/** Assess whether a task is considered 'hard' (high complexity, multi-file, or architectural). */
export function isHardTask(input: TaskComplexityInput): boolean {
  if ((input.owns?.length ?? 0) >= 3) return true;
  if ((input.acceptance_criteria?.length ?? 0) >= 4) return true;
  const fullText = `${input.task ?? ''} ${input.context ?? ''}`;
  if (fullText.length >= 3000) return true;
  if (HARD_KEYWORDS.test(fullText)) return true;
  // Reasoning effort is not a signal here: it is an owner setting for the whole bridge, not a property of one task.
  if ((input.timeout_seconds ?? 0) >= 600) return true;
  return false;
}

const MAX_PERSISTED_COOLDOWNS = 200;

export class ProfileHealthTracker {
  private cooldowns = new Map<string, number>();
  private file: string | null = null;

  /**
   * Keeps cooldowns across a restart: without it an account that has just run out of quota is picked again by the next
   * task. Anything unreadable or already expired is dropped, which only ever means "available". Writing is best effort.
   */
  attach(file: string): void {
    this.file = file;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const now = Date.now();
      for (const [id, expiresAt] of Object.entries(value).slice(0, MAX_PERSISTED_COOLDOWNS)) {
        if (id.length <= 64 && typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now) this.cooldowns.set(id, expiresAt);
      }
    } catch { /* no file, or unreadable: every profile starts available */ }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.cooldowns)), {mode: 0o600});
      renameSync(temporary, this.file);
    } catch { /* the cooldown still holds in memory; only its survival of a restart is lost */ }
  }

  /** Mark a profile as exhausted / in cooldown until now + durationSeconds. */
  markCooldown(profileId: string, durationSeconds = 900): void {
    const expiresAt = Date.now() + durationSeconds * 1000;
    this.cooldowns.set(profileId, expiresAt);
    this.save();
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
    if (this.cooldowns.delete(profileId)) this.save();
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

    // The one selection rule a pool has: the first healthy member, in the order of `members`.
    return healthyMembers[0];
  }
}

export const globalHealthTracker = new ProfileHealthTracker();
