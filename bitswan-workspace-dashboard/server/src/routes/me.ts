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

    if (gitops && gitops.hasCopy(copy)) {
      // The copy already exists — but it may PREDATE the `.copy.json` sidecar,
      // in which case gitops has no record of who it belongs to and every
      // operation that replaces its contents fails closed with a 403. On any
      // workspace that has been running a while that is every real person's
      // copy, so "Edit main's version without merging my changes" was refused
      // for all of them.
      //
      // gitops owns the copies directory, so it does the writing: this asks it
      // to record the caller as the owner IF nothing is recorded yet. The
      // identity gitops writes is the one the gate proved, not the one we send
      // — the body is there so a mismatch can be refused rather than trusted.
      //
      // Fire-and-forget: the answer changes nothing about this response, and
      // blocking every /api/me on it would make the dashboard's first paint
      // wait on a write that is almost always a no-op.
      const g = gitops;
      void g
        .ensureCopyOwner(copy, email)
        .then((r) => {
          if (!r.ok) {
            app.log.warn({ status: r.status, body: r.body, copy }, 'could not record copy owner');
          }
        })
        .catch((err: unknown) => {
          app.log.warn({ err, copy }, 'gitops unreachable recording copy owner');
        });
    }

    if (gitops && !gitops.hasCopy(copy)) {
      // Fire-and-forget: don't block the response on the (potentially slow)
      // create. A 409 means it already exists (a race or stale cache) — fine.
      // RETRY on a transient gitops outage: gitops can be momentarily
      // unreachable right after startup (its dev server reloads once on boot),
      // and a single fire-and-forget attempt that loses that race would leave
      // the user with NO copy — and then no way to create a business process.
      // Retry a few times with backoff so the copy reliably gets created.
      const g = gitops;
      void (async () => {
        // TIME-bounded retry (~6 min) rather than a fixed attempt count: a slow
        // gitops cold-start (Python app + history-cache warm + FS watchers, esp.
        // on a freshly-booted VM) can be unreachable for several minutes, and a
        // copy that never gets created leaves the user unable to create a
        // business process. The client calls /api/me once on mount, so THIS loop
        // is the only thing that will ever create the copy — it must outlast
        // gitops's worst-case boot. We keep retrying every 5s on connection
        // errors / 5xx until success (or a 4xx, which won't change on retry).
        const deadline = Date.now() + 6 * 60_000;
        let attempt = 0;
        for (;;) {
          // The SSE feed or a concurrent /api/me may have created it meanwhile.
          if (g.hasCopy(copy)) return;
          try {
            // `email` is captured from the outer request-handling scope —
            // this retry closure outlives the request itself, so the body
            // fields (not a header) are how the owner identity survives.
            const r = await g.createCopy({ branch_name: copy, kind: 'user', owner: email });
            if (r.ok || r.status === 409) return; // created, or already exists
            if (r.status >= 400 && r.status < 500) {
              app.log.warn(
                { status: r.status, body: r.body, copy, attempt },
                'gitops rejected user-copy create (not retrying)',
              );
              return; // client error — no retry
            }
            app.log.warn(
              { status: r.status, body: r.body, copy, attempt },
              'user-copy create failed (will retry)',
            );
          } catch (err) {
            app.log.warn(
              { err, copy, attempt },
              'gitops unreachable ensuring user copy — retrying',
            );
          }
          if (Date.now() > deadline) break;
          await new Promise((res) => setTimeout(res, 5000));
          attempt++;
        }
        app.log.warn({ copy }, 'gave up ensuring user copy after retries');
      })();
    }

    const role = await fwRoleFromRequest(req, gitops, app.log);
    return { email, copy, role };
  });
}
