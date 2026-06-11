import type { FastifyInstance } from 'fastify';
import { openSse } from '../lib/sse.js';
import type { GitopsClient } from '../services/gitops.js';

export interface EventRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `/api/events` — SSE pass-through of gitops's `/events/stream`. On every
 * fresh connection we replay the latest cached payload of each replayable
 * event type (`automations`, `images`, `processes`), then forward live
 * updates. This decouples a browser's page-load from gitops's own initial
 * snapshot timing — gitops only sends that snapshot once per upstream
 * stream open, and the dashboard server keeps its own subscription
 * long-lived.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  { gitops }: EventRoutesOptions,
): void {
  app.get('/api/events', async (req, reply) => {
    const ch = openSse(req, reply);

    if (!gitops) {
      // No upstream — still emit an empty automations frame so the client's
      // `status` flips to "live" and the UI can show its no-data state.
      ch.write(`event: automations\ndata: []\n\n`);
      return;
    }

    for (const [event, data] of gitops.getCachedEvents()) {
      ch.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const unsubscribe = gitops.subscribe((ev) => {
      ch.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    });
    ch.signal.addEventListener('abort', unsubscribe, { once: true });
  });
}
