import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through async calls. Carries the gate-verified
 * user email so the gitops client can forward it as X-Forwarded-Email on every
 * upstream call — gitops attributes the git task-queue entry to that user
 * without each route having to thread the email through.
 */
export const requestContext = new AsyncLocalStorage<{ email: string | null }>();

export function currentEmail(): string | null {
  return requestContext.getStore()?.email ?? null;
}
