import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { copyNameForEmail, emailFromRequest } from '../lib/user.js';

export interface CopyRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Copy creation + deletion. The listing itself flows over the `/api/events`
 * SSE feed (gitops broadcasts a `copies` event), so this file only carries
 * mutating endpoints. Validation of the branch name is delegated to
 * gitops, which has the canonical regex.
 *
 * Copy deletion is EXPERIMENTS-ONLY: a person may discard their own
 * experiment copies (Advanced menu → Discard experiment), but their personal
 * copy and main are undeletable — gitops enforces this via the copy's
 * `.copy.json` metadata (kind + owner), never by parsing the name, so a
 * legacy metadata-less copy is undeletable too. The client shows a
 * warn+confirm dialog listing unmerged/uncommitted work before calling
 * DELETE, and gitops tears down the whole experiment — live-dev
 * deployments, per-copy databases, its branch in every BP repo, and the
 * directory tree.
 */
// Gitops's copy-name allowlist (mirrors `_COPY_NAME_RE` in
// bitswan-gitops/app/routes/copies.py and the client's own copy, kept here
// so a malformed generated name 400s at the BFF instead of round-tripping to
// gitops first).
const COPY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// `-copy-` is reserved: automation_service.py parses a deployment id's copy
// scope by splitting on this literal separator, so a copy name containing it
// would make that parsing ambiguous (risk-sweep finding, adopted into the
// design doc). gitops re-validates this too — this is belt-and-suspenders so
// a bad title 400s immediately instead of after a round trip.
const RESERVED_NAME_SEPARATOR = '-copy-';

// Budget for the whole generated name, chosen so `copy_<name>_bp_<bp>` stays
// clear of the 63-char truncation `copy_bp_resource_names` applies to
// per-(copy, BP) live-dev resource names (postgres db, bucket, …) — gitops
// computes its own (workspace-specific) budget from the actual BP slugs and
// re-validates, so this is a conservative client-side pre-check, not the
// authority.
/**
 * Turn an experiment title into the opaque branch/dir name
 * `exp-<slug>-<4hex>`: lowercased, non-alphanumeric runs collapsed to a
 * single hyphen, leading/trailing hyphens trimmed, and the SLUG trimmed (never
 * the fixed `exp-`/hex parts) so the whole name fits `maxLen`. The name is
 * opaque by design (classification is via `.copy.json` metadata, never by
 * parsing it) — the title is what's actually displayed everywhere.
 *
 * `maxLen` is gitops' own budget for THIS workspace, fetched per request. It
 * used to be a hard-coded 40, but the real limit is derived from the longest
 * business-process slug (`copy_<name>_bp_<bp>` is truncated at 63 chars), so it
 * is smaller on a workspace with a long-named business process. A workspace
 * whose only process was `invoice-processing` had a budget of 36, so every
 * title long enough to reach 40 produced a name gitops rejected with a 400 —
 * "creating an experiment sometimes fails", where "sometimes" meant "depending
 * on this workspace's longest business-process name and your title".
 */
export function experimentNameFromTitle(title: string, maxLen: number): string {
  const rawSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  const hex = randomBytes(2).toString('hex'); // 4 hex chars
  const fixedLen = 'exp-'.length + '-'.length + hex.length;
  const slugBudget = Math.max(1, maxLen - fixedLen);
  const trimmed = rawSlug.slice(0, slugBudget).replace(/-+$/, '') || 'experiment';
  // `-copy-` is the deployment-id separator, so a name containing it would make
  // deployment ids ambiguous and gitops rejects it. "copy" is an ordinary word
  // in this product ("Try the new copy layout"), and the name is opaque anyway
  // — everything the user sees is the title — so rewrite the segment rather
  // than telling someone their title is unacceptable.
  const slug = trimmed
    .split('-')
    .map((segment) => (segment === 'copy' ? 'cpy' : segment))
    .join('-');
  return `exp-${slug}-${hex}`;
}

/**
 * Budget used when gitops reports none (`max_length: null` — a workspace with
 * no business processes yet, so nothing can collide). Only the copy-name regex
 * applies then; this keeps the generated name a sane length.
 */
const UNCONSTRAINED_EXPERIMENT_NAME_LEN = 40;

/** Where a version taken wholesale can come from (mirrors `ADOPT_SOURCES` in
 *  bitswan-gitops/app/routes/copies.py). */
const ADOPT_SOURCES = ['main', 'experiment', 'commit'];

/** How a copy may be published over a main that moved on (mirrors
 *  `DEPLOY_OVER_MODES` in gitops). */
const DEPLOY_OVER_MODES = ['rebase', 'exact'];

/**
 * The title of the experiment an adopt PARKS the caller's current work as:
 * `My previous Compost work — 2026-08-07 14:32`.
 *
 * It has to read as a sentence in the Advanced menu weeks later, so it names
 * the business process by its DISPLAY NAME (which is why the client sends the
 * label) and stamps the moment — several parks on the same process are
 * otherwise indistinguishable. The stamp is UTC, the same clock every other
 * timestamp the workspace records uses.
 */
export function parkedWorkTitle(bpLabel: string, now: Date = new Date()): string {
  const iso = now.toISOString();
  return `My previous ${bpLabel} work \u2014 ${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function registerCopyRoutes(
  app: FastifyInstance,
  { gitops }: CopyRoutesOptions,
): void {
  // Delete a whole copy. EXPERIMENTS-ONLY: gitops 400s for main, user copies,
  // and legacy copies (no metadata or kind != experiment), and 403s unless
  // the requester is the experiment's owner. Answers 202 + a task id and
  // runs the teardown on its queue; the `copies` SSE snapshot dropping the
  // copy is the completion signal. The unmerged-work warning is a CLIENT
  // concern — the server never blocks on divergence.
  app.delete<{ Params: { name: string } }>(
    '/api/copies/:name',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const deletedBy = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.deleteCopy({
          name,
          ...(deletedBy ? { deleted_by: deletedBy } : {}),
        });
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return reply.code(202).send(r.body);
      } catch (err) {
        app.log.warn({ err, name }, 'copy delete failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{ Params: { name: string }; Body: { bp?: string } }>(
    '/api/copies/:name/sync',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      // Optional: scope the sync to one business process (only its commits go
      // to main). Client-supplied; gitops validates the name.
      const bp =
        typeof req.body?.bp === 'string' && req.body.bp ? req.body.bp : undefined;
      // The deployer recorded on the deploy tag is the validated token email,
      // never a client-supplied value — it can't be spoofed.
      const deployer = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.syncCopy(name, deployer ?? undefined, bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name }, 'copy sync failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Pull main into ONE business process of a copy. `bp` is required: pulling
  // is the mirror of deploying and deploying is per business process, because
  // each one is its own repository. An unscoped pull would move processes the
  // user was never shown and never agreed to — so the omission is a 400 rather
  // than a whole-copy rebase.
  app.post<{ Params: { name: string }; Body: { bp?: string } }>(
    '/api/copies/:name/rebase',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const bp = typeof req.body?.bp === 'string' ? req.body.bp.trim() : '';
      if (!bp) {
        return reply.code(400).send({
          error:
            'bp is required — main is pulled into one business process at a ' +
            'time, because each one is its own repository',
        });
      }
      // The deployer recorded on any follow-up redeploy is the validated token
      // email, never a client-supplied value — it can't be spoofed.
      const deployer = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.rebaseCopy(name, bp, deployer ?? undefined);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name }, 'copy rebase failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Merge an experiment back into the copy it branched from. Clone of the
  // rebase route above: same guard-free shape (gitops owns the kind==
  // experiment + owner checks), same 4xx passthrough / 502-on-unreachable
  // pattern. Never touches main and deploys nothing new — it fast-forwards
  // the PARENT's branch and redeploys only the parent's live-dev.
  app.post<{ Params: { name: string } }>(
    '/api/copies/:name/merge-to-parent',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      // The deployer recorded on any follow-up parent redeploy is the
      // validated token email, never a client-supplied value — it can't be
      // spoofed.
      const deployer = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.mergeCopyToParent(name, deployer ?? undefined);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name }, 'copy merge-to-parent failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{ Params: { name: string; bp: string } }>(
    '/api/copies/:name/bp/:bp/ensure',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name, bp } = req.params;
      if (!name || !bp) {
        return reply.code(400).send({ error: 'name and bp are required' });
      }
      try {
        const r = await gitops.ensureBpInCopy(name, bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name, bp }, 'ensure bp in copy failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/history',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyHistory(req.params.name, req.query.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy history failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // What a pull would bring into ONE business process: the arriving commits
  // and — the half the Sync screen was missing — the files they change. Its
  // sibling below serves the diff behind a row in that file list.
  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/incoming',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      if (!req.query.bp) {
        return reply.code(400).send({ error: 'bp is required' });
      }
      try {
        const r = await gitops.copyIncoming(req.params.name, req.query.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy incoming failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{
    Params: { name: string };
    Querystring: { bp?: string; path?: string };
  }>('/api/copies/:name/incoming/diff', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    if (!req.query.bp) {
      return reply.code(400).send({ error: 'bp is required' });
    }
    try {
      const r = await gitops.copyIncomingDiff(
        req.params.name,
        req.query.bp,
        req.query.path,
      );
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name: req.params.name }, 'copy incoming diff failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // What merging an experiment back would carry into its parent copy. The
  // experiment banner asks this instead of /status: /status measures the copy
  // against MAIN, and an experiment inherits its parent's whole divergence
  // from main, so it can never say "nothing left to merge".
  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/merge-preview',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyMergePreview(req.params.name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy merge-preview failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/divergence-all',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyDivergenceAll(req.params.name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn(
          { err, name: req.params.name },
          'copy divergence-all failed',
        );
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // ONE divergence reading, for ONE business process — and the ONLY definition
  // of "behind main" the client has. It gates both the Sync step (behind_bp)
  // and the Deploy button (a publish must be a fast-forward), which are the
  // same fact asked twice; there used to be a second, copy-wide `/behind`
  // endpoint feeding the Sync step, and the two disagreed exactly as you would
  // expect — a Sync step appeared while the user was on a business process
  // that was perfectly up to date, offering another one's commits.
  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/divergence',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      if (!req.query.bp) {
        return reply.code(400).send({ error: 'bp is required' });
      }
      try {
        const r = await gitops.copyDivergence(req.params.name, req.query.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy divergence failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{
    Body: { branch_name?: string; base_branch?: string };
  }>('/api/copies', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { branch_name, base_branch } = req.body ?? {};
    if (!branch_name || typeof branch_name !== 'string') {
      return reply.code(400).send({ error: 'branch_name is required' });
    }
    try {
      const r = await gitops.createCopy({
        branch_name,
        ...(base_branch ? { base_branch } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, branch_name }, 'copy create failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // ── taking a version wholesale ────────────────────────────────────────────
  //
  // Adopt a version into the caller's own copy for ONE business process:
  // an experiment ("use this version without merging"), main ("edit the main
  // version without merging my changes"), or a version this workspace
  // DEPLOYED ("edit this version" — the hotpatch).
  //
  // The name and title of the experiment the caller's current work is PARKED
  // as are minted here, because this is where copy names are minted (one slug
  // generator, `experimentNameFromTitle`) and because the title needs the
  // business process's DISPLAY NAME, which only the client knows. gitops asks
  // for them only when there is genuinely something to park.
  app.post<{
    Params: { name: string };
    Body: {
      bp?: string;
      source?: string;
      experiment?: string;
      commit?: string;
      bpLabel?: string;
    };
  }>('/api/copies/:name/adopt', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { name } = req.params;
    const bp = typeof req.body?.bp === 'string' ? req.body.bp.trim() : '';
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    if (!name || !bp) {
      return reply.code(400).send({ error: 'name and bp are required' });
    }
    if (!ADOPT_SOURCES.includes(source)) {
      return reply
        .code(400)
        .send({ error: `source must be one of ${ADOPT_SOURCES.join(', ')}` });
    }
    if (source === 'experiment' && !req.body?.experiment) {
      return reply
        .code(400)
        .send({ error: "source 'experiment' needs an experiment name" });
    }
    if (source === 'commit' && !req.body?.commit) {
      return reply.code(400).send({ error: "source 'commit' needs a commit" });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    // The copy being adopted INTO is the caller's own, derived from the
    // verified identity — the client does not get to name someone else's.
    // gitops re-checks ownership from `.copy.json`; this makes the common case
    // unspoofable rather than merely rejected.
    if (name !== copyNameForEmail(email)) {
      return reply
        .code(403)
        .send({ error: 'a version is adopted into your own copy' });
    }
    const budget = await gitops.copyNameBudget();
    if (!budget.ok) {
      return reply
        .code(budget.status >= 400 && budget.status < 500 ? budget.status : 502)
        .send({ error: 'could not read the copy-name limit from gitops' });
    }
    const reported = (budget.body as { max_length?: number | null } | null)
      ?.max_length;
    const maxLen =
      typeof reported === 'number' ? reported : UNCONSTRAINED_EXPERIMENT_NAME_LEN;
    const bpLabel =
      typeof req.body?.bpLabel === 'string' && req.body.bpLabel.trim()
        ? req.body.bpLabel.trim()
        : bp;
    const parkTitle = parkedWorkTitle(bpLabel);
    try {
      const r = await gitops.adoptVersion(name, {
        bp,
        source,
        experiment: req.body?.experiment ?? null,
        commit: req.body?.commit ?? null,
        park_name: experimentNameFromTitle(parkTitle, maxLen),
        park_title: parkTitle,
        deployer: email,
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name, bp, source }, 'adopt version failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Put the DEV stage back to a version it ran before. This is a change to
  // MAIN (dev deploys from main), made forward-only as one commit on top —
  // so everybody else's copy goes one behind and carries it on their next
  // Sync. The client's confirm dialog says exactly that before calling.
  app.post<{
    Params: { bp: string };
    Body: { commit?: string; bpLabel?: string };
  }>('/api/copies/main/bp/:bp/revert-dev', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { bp } = req.params;
    const commit = typeof req.body?.commit === 'string' ? req.body.commit.trim() : '';
    if (!bp || !commit) {
      return reply.code(400).send({ error: 'bp and commit are required' });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    try {
      const r = await gitops.revertDevToVersion(bp, {
        commit,
        bp_label: req.body?.bpLabel ?? null,
        deployer: email,
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp, commit }, 'dev revert failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Whose work "Deploy this version, overwriting main" would go over — short
  // sha, subject and AUTHOR for every main commit this copy does not have.
  // The confirm dialog is built from this, because "overwrite main" with no
  // names attached is a button nobody can consent to.
  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/deploy-over-main-preview',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const bp = typeof req.query?.bp === 'string' ? req.query.bp.trim() : '';
      if (!bp) {
        return reply.code(400).send({ error: 'bp is required' });
      }
      try {
        const r = await gitops.deployOverMainPreview(req.params.name, bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name, bp }, 'deploy-over preview failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Publish this copy's version of one business process even though main has
  // moved on. `rebase` replays my commits onto main with my side winning the
  // hunks we both touched (main's untouched additions kept); `exact` makes
  // main byte-for-byte my version. `expectedMain` is the tip the confirm
  // dialog described — if main moved since, gitops 409s rather than
  // superseding work the user was never shown.
  app.post<{
    Params: { name: string };
    Body: { bp?: string; mode?: string; expectedMain?: string };
  }>('/api/copies/:name/deploy-over-main', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { name } = req.params;
    const bp = typeof req.body?.bp === 'string' ? req.body.bp.trim() : '';
    const mode = typeof req.body?.mode === 'string' ? req.body.mode.trim() : 'rebase';
    if (!name || !bp) {
      return reply.code(400).send({ error: 'name and bp are required' });
    }
    if (!DEPLOY_OVER_MODES.includes(mode)) {
      return reply
        .code(400)
        .send({ error: `mode must be one of ${DEPLOY_OVER_MODES.join(', ')}` });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    if (name !== copyNameForEmail(email)) {
      return reply
        .code(403)
        .send({ error: 'only your own copy can be published over main' });
    }
    try {
      const r = await gitops.deployOverMain(name, {
        bp,
        mode,
        expected_main: req.body?.expectedMain ?? null,
        deployer: email,
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name, bp, mode }, 'deploy over main failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Start an experiment off the caller's own copy. The parent and owner are
  // both derived from the verified identity — never client-supplied — and
  // the name is a generated opaque slug; the user only names the thing
  // they're trying out (`title`) and the business process they're trying it
  // out ON (`bp`).
  //
  // `bp` is REQUIRED. An experiment is a side branch off one business process,
  // and gitops clones exactly the ones it is given: a missing `bp` would
  // create a real but EMPTY experiment (nothing cloned, nothing to work on)
  // and look like a bug in whatever the user does next. So the omission is
  // rejected here rather than papered over with a default.
  app.post<{ Body: { title?: string; bp?: string } }>(
    '/api/experiments',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        return reply.code(400).send({ error: 'title is required' });
      }
      const bp = typeof req.body?.bp === 'string' ? req.body.bp.trim() : '';
      if (!bp) {
        return reply.code(400).send({
          error:
            'bp is required — an experiment is started on a business process, ' +
            'and it is the only one cloned into it',
        });
      }
      const email = await emailFromRequest(req, app.log);
      if (!email) {
        return reply.code(401).send({ error: 'not authenticated' });
      }
      const parent = copyNameForEmail(email);
      // Ask gitops how long a copy name may be HERE. The limit depends on this
      // workspace's longest business-process name, so a generator carrying its
      // own number produces names gitops rejects on some workspaces.
      const budget = await gitops.copyNameBudget();
      if (!budget.ok) {
        return reply.code(budget.status >= 400 && budget.status < 500 ? budget.status : 502).send({
          error: 'could not read the copy-name limit from gitops',
          status: budget.status,
          body: budget.body,
        });
      }
      const reported = (budget.body as { max_length?: number | null } | null)
        ?.max_length;
      if (reported !== null && reported !== undefined && typeof reported !== 'number') {
        return reply.code(502).send({
          error: 'gitops reported a copy-name limit that is not a number',
          body: budget.body,
        });
      }
      const maxLen = reported ?? UNCONSTRAINED_EXPERIMENT_NAME_LEN;
      const name = experimentNameFromTitle(title, maxLen);
      if (!COPY_NAME_RE.test(name)) {
        // Unreachable in practice — the generator only ever emits allowed
        // characters — kept as defense in depth, mirroring gitops's own check.
        return reply
          .code(400)
          .send({ error: 'generated experiment name is invalid' });
      }
      if (name.includes(RESERVED_NAME_SEPARATOR)) {
        return reply
          .code(400)
          .send({ error: 'that title produces a reserved name; please rephrase it' });
      }
      try {
        const r = await gitops.createCopy({
          branch_name: name,
          kind: 'experiment',
          parent,
          owner: email,
          title,
          // Exactly the one business process being tried out. gitops 400s with
          // actionable text ("<bp> is not in <parent>") when the parent copy
          // doesn't carry it — relayed below verbatim, since it names the fix.
          bps: [bp],
        });
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        const body = r.body && typeof r.body === 'object' ? r.body : {};
        return { ...body, name };
      } catch (err) {
        app.log.warn({ err, name, parent, bp }, 'experiment create failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );
}
