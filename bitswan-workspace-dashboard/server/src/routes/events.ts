import type { FastifyInstance } from 'fastify';
import { openSse } from '../lib/sse.js';
import type { GitopsClient } from '../services/gitops.js';

export interface EventRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `/api/events` — SSE pass-through of gitops's `/events/stream`. Each
 * connection receives an initial `snapshot` event so the UI can paint
 * before the next upstream tick.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  { gitops }: EventRoutesOptions,
): void {
  app.get('/api/events', async (req, reply) => {
    const ch = openSse(req, reply);

    const snapshot = gitops ? gitops.getSnapshot() : [];
    ch.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    if (!gitops) return;
    const unsubscribe = gitops.subscribe((ev) => {
      ch.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    });
    ch.signal.addEventListener('abort', unsubscribe, { once: true });
  });
}
