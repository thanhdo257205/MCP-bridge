import path from 'node:path';
import * as z from 'zod/v4';
import { redact } from './security/redact.js';

/**
 * Task notifications, after Orca's "get pinged when an agent needs you": when a task ends, the bridge POSTs one short message to a URL the
 * owner chose (an ntfy topic, a chat webhook, a local script). Off unless configured, and only the owner's config can turn it on: this is the
 * one place the bridge sends anything off the machine by itself. The message carries no prompt, answer, log or diff, and no full path; the
 * task's first line only with `include_title`. A failed send is logged and never changes the task.
 */
export const NOTIFY_EVENTS = ['completed', 'failed', 'timeout', 'canceled', 'denied', 'quota'] as const;
export type NotifyEvent = typeof NOTIFY_EVENTS[number];

export const notifySchema = z.object({
  url: z.string().max(2048).refine(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }, 'notify.url must be an http or https URL'),
  /** Which endings are sent. `denied` and `quota` are failures with a cause the owner can act on, so they are named separately. */
  events: z.array(z.enum(NOTIFY_EVENTS)).min(1).max(NOTIFY_EVENTS.length).default(['completed', 'failed', 'timeout', 'denied', 'quota']),
  /** `json` (one object) or `text` (one line, what ntfy.sh and most chat webhooks display as is). */
  format: z.enum(['json', 'text']).default('json'),
  /** Adds the first line of the task (secrets filtered, 140 characters) to the message. Off by default: it is text from a client. */
  include_title: z.boolean().default(false)
}).strict();
export type NotifyConfig = z.infer<typeof notifySchema>;

export interface NotifySubject {
  task_id: string; status: string; agent: string; workspace: string; duration_ms: number; error: string | null;
  denied_actions: unknown[]; cli_status: string | null;
}

/** Which event a finished task is: a refusal or an exhausted quota is reported as such, not as a plain failure. */
export function eventOf(task: NotifySubject): NotifyEvent | null {
  if (task.status === 'completed') return 'completed';
  if (task.denied_actions.length) return 'denied';
  if (task.cli_status === 'quota_exceeded') return 'quota';
  if (task.status === 'failed' || task.status === 'timeout' || task.status === 'canceled') return task.status;
  return null;
}

const LABEL: Record<NotifyEvent, string> = {completed: 'completed', failed: 'failed', timeout: 'timed out', canceled: 'canceled', denied: 'needs approval', quota: 'out of quota'};

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function notificationBody(config: NotifyConfig, task: NotifySubject, event: NotifyEvent, title: string | null): {body: string; contentType: string} {
  const project = path.basename(task.workspace) || task.workspace;
  const shownTitle = config.include_title && title ? redact(title).slice(0, 140) : null;
  const error = event === 'completed' || !task.error ? null : redact(task.error).slice(0, 300);
  if (config.format === 'text') {
    const line = `[bridge] ${task.agent} ${LABEL[event]} · ${project} · ${duration(task.duration_ms)} · ${task.task_id.slice(0, 8)}`;
    return {body: [line, shownTitle, error].filter(Boolean).join('\n'), contentType: 'text/plain; charset=utf-8'};
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify({
      source: 'agy-mcp-bridge', event, task_id: task.task_id, status: task.status, agent: task.agent, project, duration_ms: task.duration_ms,
      denied_actions: task.denied_actions.length, ...(error ? {error} : {}), ...(shownTitle ? {title: shownTitle} : {})
    })
  };
}

/** Sends one notification if the task's event is wanted. Resolves either way within about five seconds; never throws. */
export async function notifyTaskEnd(config: NotifyConfig | undefined, task: NotifySubject, title: string | null, send: typeof fetch = fetch): Promise<boolean> {
  if (!config) return false;
  const event = eventOf(task);
  if (!event || !config.events.includes(event)) return false;
  const {body, contentType} = notificationBody(config, task, event, title);
  try {
    const response = await send(config.url, {method: 'POST', headers: {'Content-Type': contentType}, body, redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (!response.ok) console.error(`[bridge] Task notification was refused by ${new URL(config.url).host} (HTTP ${response.status})`);
    return response.ok;
  } catch (error) {
    console.error(`[bridge] Task notification to ${new URL(config.url).host} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return false;
  }
}
