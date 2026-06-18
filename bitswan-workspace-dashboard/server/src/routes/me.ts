import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { copyNameForEmail, emailFromRequest, fwRoleFromRequest } from '../lib/user.js';

export interface MeRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `GET /api/me` — identifies the logged-in user and ensures they have their
 * own copy (an independent git checkout), created on first visit and reused
 * after. The copy name is returned so the client can auto-select it.
 *
 * Creation is kicked off in the BACKGROUND and not awaited: building a copy
 * (clone + Postgres + live-dev deploys) can take many seconds on a busy
 * workspace, and the dashboard must not block on it. The copy surfaces over
 * the `copies` SSE feed when ready; the client shows a "setting up" state
 * until then. Creation is idempotent — gitops returns 409 when the copy
 * already exists (the normal returning-user case).
 */
export function registerMeRoutes(
  app: FastifyInstance,
  { gitops }: MeRoutesOptions,
): void {
  app.get('/api/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    const copy = copyNameForEmail(email);

    if (gitops && !gitops.hasCopy(copy)) {
      // Fire-and-forget: don't block the response on the (potentially slow)
      // create. A 409 means it already exists (a race or stale cache) — fine.
      void gitops
        .createCopy({ branch_name: copy })
        .then((r) => {
          if (!r.ok && r.status !== 409) {
            app.log.warn(
              { status: r.status, body: r.body, copy },
              'failed to ensure user copy',
            );
          }
        })
        .catch((err) => {
          app.log.warn({ err, copy }, 'gitops unreachable ensuring user copy');
        });
    }

    const role = await fwRoleFromRequest(req, app.log);
    return { email, copy, role };
  });
}
