import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-HTTP-request facts the MCP handler cannot see: stateless requests carry no initialize, so the User-Agent is the fallback client label. */
export const requestContext = new AsyncLocalStorage<{userAgent: string | undefined}>();
