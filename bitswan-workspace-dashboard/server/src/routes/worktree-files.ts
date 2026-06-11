import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isValidWorktreeName } from '../services/workspace.js';
import {
  ensureWorktreeDir,
  readWorktreeFile,
  readWorktreeTree,
  writeWorktreeFile,
  type FileEtag,
} from '../services/worktree-files.js';
import type { GitopsClient } from '../services/gitops.js';

export interface WorktreeFilesRoutesOptions {
  workspaceRoot: string;
  gitops: GitopsClient | null;
}

/**
 * Read-only worktree introspection for the dashboard's Files / Diff
 * tabs. File-tree + content come straight from the bind-mounted
 * workspace; status + diff proxy to gitops (which runs git inside the
 * repo).
 */
export function registerWorktreeFilesRoutes(
  app: FastifyInstance,
  { workspaceRoot, gitops }: WorktreeFilesRoutesOptions,
): void {
  app.get<{ Params: { name: string } }>(
    '/api/worktrees/:name/files',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isValidWorktreeName(req.params.name)) {
        return reply.code(400).send({ error: 'invalid worktree' });
      }
      try {
        return await readWorktreeTree({
          worktree: req.params.name,
          workspaceRoot,
        });
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'tree walk failed');
        return reply.code(500).send({ error: String(err) });
      }
    },
  );

  app.get<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/worktrees/:name/files/content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidWorktreeName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    const p = req.query.path;
    if (!p || typeof p !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      const r = await readWorktreeFile({
        worktree: req.params.name,
        path: p,
        workspaceRoot,
      });
      if ('error' in r) {
        const status =
          r.error === 'not-found' ? 404 : r.error === 'too-large' ? 413 : 415;
        return reply.code(status).send({ error: r.error });
      }
      return r;
    } catch (err) {
      app.log.warn({ err, name: req.params.name, path: p }, 'file read failed');
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.put<{
    Params: { name: string };
    Querystring: { path?: string };
    Body: { content?: unknown; etag?: unknown };
  }>('/api/worktrees/:name/files/content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidWorktreeName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    const p = req.query.path;
    if (!p || typeof p !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }
    const body = req.body ?? {};
    if (typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'content must be a string' });
    }
    // etag is optional. When present we compare-and-set against the
    // file's current mtime/size — fails with 409 on out-of-band edits.
    let expectedEtag: FileEtag | undefined;
    if (body.etag !== undefined && body.etag !== null) {
      const e = body.etag as { mtimeMs?: unknown; size?: unknown };
      if (typeof e.mtimeMs !== 'number' || typeof e.size !== 'number') {
        return reply.code(400).send({ error: 'invalid etag' });
      }
      expectedEtag = { mtimeMs: e.mtimeMs, size: e.size };
    }
    try {
      const r = await writeWorktreeFile({
        worktree: req.params.name,
        path: p,
        workspaceRoot,
        content: body.content,
        ...(expectedEtag ? { expectedEtag } : {}),
      });
      if ('error' in r) {
        if (r.error === 'conflict') {
          return reply.code(409).send({
            error: 'conflict',
            expected: r.expected,
            actual: r.actual,
          });
        }
        const code =
          r.error === 'not-found' ? 404 : r.error === 'too-large' ? 413 : 415;
        return reply.code(code).send({ error: r.error });
      }
      return r;
    } catch (err) {
      app.log.warn({ err, name: req.params.name, path: p }, 'file write failed');
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.post<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/worktrees/:name/files/upload', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidWorktreeName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    const targetRel = req.query.path ?? '';
    let targetDir: string;
    try {
      targetDir = await ensureWorktreeDir({
        worktree: req.params.name,
        path: targetRel,
        workspaceRoot,
      });
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected multipart/form-data' });
    }
    const written: { name: string; size: number }[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        // `part.filename` is the client-supplied name; reduce to basename
        // to defeat any `../foo` games and keep the upload inside the
        // resolved target dir.
        const name = path.basename(part.filename ?? '');
        if (!name || name === '.' || name === '..') continue;
        const dest = path.join(targetDir, name);
        // Use a write stream so we don't buffer the whole upload in
        // memory; @fastify/multipart's per-file size limit still applies.
        const tmp = `${dest}.upload-${process.pid}-${Date.now()}`;
        try {
          await fs.writeFile(tmp, part.file);
        } catch (e) {
          // Clean up any partial tmp on failure.
          await fs.unlink(tmp).catch(() => undefined);
          throw e;
        }
        await fs.rename(tmp, dest);
        const st = await fs.stat(dest);
        written.push({ name, size: st.size });
      }
    } catch (err) {
      app.log.warn({ err, name: req.params.name }, 'upload failed');
      return reply.code(500).send({ error: String(err) });
    }
    return { written };
  });

  app.get<{ Params: { name: string } }>(
    '/api/worktrees/:name/status',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isValidWorktreeName(req.params.name)) {
        return reply.code(400).send({ error: 'invalid worktree' });
      }
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.worktreeStatus(req.params.name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'status proxy failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/worktrees/:name/diff', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidWorktreeName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    try {
      const r = await gitops.worktreeDiff(req.params.name, req.query.path);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name: req.params.name }, 'diff proxy failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}
