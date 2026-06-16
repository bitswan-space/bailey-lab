import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { copyNameForEmail, emailFromRequest } from '../lib/user.js';

export interface MeRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `GET /api/me` — identifies the logged-in user and ensures they have their
 * own copy (an independent git checkout). The copy is created on the user's
 * FIRST visit and reused on every subsequent one; creation is idempotent
 * (gitops returns 409 when the copy already exists). The client uses the
 * returned `copy` name to auto-select the user's copy.
 */
export function registerMeRoutes(
  app: FastifyInstance,
  { gitops }: MeRoutesOptions,
): void {
  app.get('/api/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const email = emailFromRequest(req);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    const copy = copyNameForEmail(email);

    let created = false;
    if (gitops) {
      try {
        const r = await gitops.createWorktree({ branch_name: copy });
        if (r.ok) {
          created = true;
        } else if (r.status !== 409) {
          // 409 = already exists, which is the normal (returning-user) case.
          // Any other status is unexpected; log it but still return the copy
          // name so the client can select the copy if/when it appears.
          app.log.warn(
            { status: r.status, body: r.body, copy },
            'failed to ensure user copy',
          );
        }
      } catch (err) {
        app.log.warn({ err, copy }, 'gitops unreachable ensuring user copy');
      }
    }

    return { email, copy, created };
  });
}
