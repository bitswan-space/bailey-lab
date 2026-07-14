import type { FastifyInstance } from 'fastify';
import {
  isValidBpId,
  isValidCopyName,
  readReadme,
} from '../services/workspace.js';
import {
  addRequirement,
  annotateHasTest,
  isReqStatus,
  listRequirements,
  removeRequirement,
  updateRequirement,
  type ReqStatus,
} from '../services/requirements.js';
import {
  isSafeRequirementId,
  runRequirementTests,
} from '../services/agent-exec.js';
import { emailFromRequest } from '../lib/user.js';
import type { GitopsClient } from '../services/gitops.js';

export interface BusinessProcessRoutesOptions {
  workspaceRoot: string;
  gitops: GitopsClient | null;
}

/**
 * Per-BP filesystem helpers. The BP listing itself isn't served here —
 * it flows over the `/api/events` SSE feed (cached from gitops's
 * `processes` event), so the only HTTP surface left is the README
 * lookup, which still needs direct filesystem access via the workspace
 * bind-mount.
 *
 * The README endpoint accepts an optional `?copy=<name>` query so the
 * dashboard can show the copy's version of the spec when the user is in
 * a copy scope (READMEs frequently diverge between main and a
 * copy mid-development).
 */
export function registerBusinessProcessRoutes(
  app: FastifyInstance,
  { workspaceRoot, gitops }: BusinessProcessRoutesOptions,
): void {
  app.post<{
    Body: { name?: string; copy?: string };
  }>('/api/business-processes', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { name, copy } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name is required' });
    }
    // The creator recorded on the BP's git commits is the validated token email,
    // never a client-supplied value — so history shows who made the BP.
    const createdBy = await emailFromRequest(req, app.log);
    try {
      const r = await gitops.createProcess({
        name,
        ...(copy ? { copy } : {}),
        ...(createdBy ? { created_by: createdBy } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name, copy }, 'BP create failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Rename = change the display name only. `:id` is the immutable slug —
  // gitops rewrites the `name` key in the BP's process.toml and commits it,
  // then the updated `processes` snapshot arrives over SSE.
  app.patch<{
    Params: { id: string };
    Body: { name?: string; copy?: string };
  }>('/api/business-processes/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    if (!isValidBpId(req.params.id)) {
      return reply.code(400).send({ error: 'invalid bp id' });
    }
    const { name, copy } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name is required' });
    }
    if (copy !== undefined && !isValidCopyName(copy)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    // Like create: the git author of the rename commit is the validated
    // token email, never a client-supplied value.
    const renamedBy = await emailFromRequest(req, app.log);
    try {
      const r = await gitops.renameProcess({
        slug: req.params.id,
        name,
        ...(copy ? { copy } : {}),
        ...(renamedBy ? { renamed_by: renamedBy } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, id: req.params.id, copy }, 'BP rename failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Delete a whole BP. Gitops guards it (409 with a structured detail while
  // staging/production deployments exist — the 4xx passthrough below carries
  // that payload verbatim so the dialog can render the blocking deployments)
  // and runs the teardown async (202 + task id); the `processes` SSE snapshot
  // dropping the BP is the completion signal.
  app.delete<{
    Params: { id: string };
  }>('/api/business-processes/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    if (!isValidBpId(req.params.id)) {
      return reply.code(400).send({ error: 'invalid bp id' });
    }
    // Attribution for the delete commit + queue task: the validated token
    // email, never a client-supplied value.
    const deletedBy = await emailFromRequest(req, app.log);
    try {
      const r = await gitops.deleteProcess({
        slug: req.params.id,
        ...(deletedBy ? { deleted_by: deletedBy } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return reply.code(202).send(r.body);
    } catch (err) {
      app.log.warn({ err, id: req.params.id }, 'BP delete failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { copy?: string };
  }>('/api/business-processes/:id/readme', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidBpId(req.params.id)) {
      return reply.code(400).send({ error: 'invalid bp id' });
    }
    const copy = req.query.copy;
    if (copy !== undefined && !isValidCopyName(copy)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    const content = await readReadme(req.params.id, workspaceRoot, copy);
    return { content };
  });

  // ---- Testable requirements ------------------------------------------
  //
  // Copy-only. The TOML file lives at
  //   <workspaceRoot>/copies/<copy>/<bp>/testable-requirements.toml
  // and is shared with `bitswan-coding-agent requirements …` — both write
  // the same schema. See server/src/services/requirements.ts.

  function validateBpCopy(bp: string, copy?: string): string | null {
    if (!isValidBpId(bp)) return 'invalid bp id';
    if (!copy) return 'copy is required';
    if (!isValidCopyName(copy)) return 'invalid copy';
    return null;
  }

  app.get<{
    Params: { id: string };
    Querystring: { copy?: string };
  }>('/api/business-processes/:id/requirements', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpCopy(req.params.id, req.query.copy);
    if (err) return reply.code(400).send({ error: err });
    try {
      const scope = { workspaceRoot, copy: req.query.copy!, bp: req.params.id };
      // hasTest drives the UI's per-row Run button — no test yet, no run.
      return await annotateHasTest(scope, await listRequirements(scope));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: e, id: req.params.id }, 'requirements list failed');
      return reply.code(500).send({ error: msg });
    }
  });

  // Run the deterministic tests for one requirement (`{ id }`) or every
  // non-proposed requirement (empty body). Drives
  // `bitswan-coding-agent requirements test` inside the BP's live-dev
  // container over SSH — the CLI writes pass/fail back to the TOML, which we
  // re-read and return so the UI reflects the new statuses immediately.
  app.post<{
    Params: { id: string };
    Querystring: { copy?: string };
    Body: { id?: string };
  }>('/api/business-processes/:id/requirements/run-tests', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const bp = req.params.id;
    const copy = req.query.copy;
    const err = validateBpCopy(bp, copy);
    if (err) return reply.code(400).send({ error: err });
    const reqId = req.body?.id;
    if (reqId !== undefined && (typeof reqId !== 'string' || !isSafeRequirementId(reqId))) {
      return reply.code(400).send({ error: 'invalid requirement id' });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) return reply.code(401).send({ error: 'not authenticated' });
    try {
      const result = await runRequirementTests({
        copy: copy!,
        bp,
        email,
        ...(reqId ? { id: reqId } : {}),
      });
      // The CLI wrote the verdicts into the TOML; hand back the canonical list
      // alongside the run output so the client doesn't need a second fetch.
      const scope = { workspaceRoot, copy: copy!, bp };
      const requirements = await annotateHasTest(scope, await listRequirements(scope));
      return {
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        output: result.output,
        requirements,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: e, id: bp }, 'requirements run-tests failed');
      return reply.code(502).send({ error: msg });
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { copy?: string };
    Body: { text?: string; parent?: string; status?: string };
  }>('/api/business-processes/:id/requirements', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpCopy(req.params.id, req.query.copy);
    if (err) return reply.code(400).send({ error: err });
    const { text, parent, status } = req.body ?? {};
    if (text !== undefined && typeof text !== 'string') {
      return reply.code(400).send({ error: 'text must be a string' });
    }
    if (status !== undefined && !isReqStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    try {
      return await addRequirement({
        workspaceRoot,
        copy: req.query.copy!,
        bp: req.params.id,
        text: text ?? '',
        ...(parent ? { parent } : {}),
        ...(status ? { status: status as ReqStatus } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: e, id: req.params.id }, 'requirements add failed');
      return reply.code(400).send({ error: msg });
    }
  });

  app.patch<{
    Params: { id: string; reqId: string };
    Querystring: { copy?: string };
    Body: { description?: string; status?: string };
  }>('/api/business-processes/:id/requirements/:reqId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpCopy(req.params.id, req.query.copy);
    if (err) return reply.code(400).send({ error: err });
    const { description, status } = req.body ?? {};
    if (status !== undefined && !isReqStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (description === undefined && status === undefined) {
      return reply.code(400).send({ error: 'description or status required' });
    }
    try {
      return await updateRequirement({
        workspaceRoot,
        copy: req.query.copy!,
        bp: req.params.id,
        id: req.params.reqId,
        patch: {
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status: status as ReqStatus } : {}),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('not found') ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete<{
    Params: { id: string; reqId: string };
    Querystring: { copy?: string };
  }>('/api/business-processes/:id/requirements/:reqId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpCopy(req.params.id, req.query.copy);
    if (err) return reply.code(400).send({ error: err });
    try {
      await removeRequirement({
        workspaceRoot,
        copy: req.query.copy!,
        bp: req.params.id,
        id: req.params.reqId,
      });
      return reply.code(204).send();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('not found') ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });
}
