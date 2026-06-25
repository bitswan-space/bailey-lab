import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { emailFromRequest, fwRoleFromRequest } from '../lib/user.js';

export interface TaskRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Git task-queue proxy. The live queue itself flows over the `/api/events`
 * SSE feed (gitops broadcasts a `task_queue_snapshot` on connect and a
 * `task_queue` event per change), so this file carries only the initial
 * fetch and the admin "clear queue" mutation.
 */
export function registerTaskRoutes(
  app: FastifyInstance,
  { gitops }: TaskRoutesOptions,
): void {
  // `GET /api/tasks` — initial queue snapshot for a freshly-loaded client
  // (the SSE feed then keeps it live). Mirrors gitops's `{ tasks: [...] }`.
  app.get('/api/tasks', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    try {
      const r = await gitops.listTasks();
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err }, 'task queue list failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // `POST /api/tasks/clear` — cancel all queued/running git tasks. Admin-only:
  // gitops enforces it server-side (403 for non-admins), but we also gate here
  // so the dashboard fails closed and never even issues the request for a
  // non-admin. `by` is the validated header email, never client-supplied.
  app.post('/api/tasks/clear', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    const role = await fwRoleFromRequest(req, gitops, app.log);
    if (role !== 'admin') {
      return reply.code(403).send({ error: 'admin only' });
    }
    try {
      const r = await gitops.clearTasks(email);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err }, 'task queue clear failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}
