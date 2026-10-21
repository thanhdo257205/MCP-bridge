import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

/**
 * In-memory UI sessions. The session id travels in a request header (never a cookie), so no browser
 * credential is sent automatically: other pages and other ports on 127.0.0.1 cannot ride on it.
 */
export class SessionStore {
  private sessions = new Map<string, number>();
  private failures: number[] = [];
  constructor(private now: () => number = Date.now) {}

  throttled(): boolean {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter(time => time > cutoff);
    return this.failures.length >= MAX_FAILURES;
  }
  recordFailure(): void { this.failures.push(this.now()); }
  create(): string {
    this.prune();
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, this.now() + SESSION_TTL_MS);
    return id;
  }
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    if (expires <= this.now()) { this.sessions.delete(id); return false; }
    return true;
  }
  destroy(id: string | undefined): void { if (id) this.sessions.delete(id); }
  private prune() { for (const [id, expires] of this.sessions) if (expires <= this.now()) this.sessions.delete(id); }
}
