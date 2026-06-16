import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isValidCopyName } from '../services/workspace.js';
import {
  deleteCopyFile,
  ensureCopyDir,
  readCopyFile,
  readCopyTree,
  statCopyFile,
  writeCopyFile,
  type FileEtag,
} from '../services/copy-files.js';
import type { GitopsClient } from '../services/gitops.js';

export interface CopyFilesRoutesOptions {
  workspaceRoot: string;
  gitops: GitopsClient | null;
}

/**
 * Read-only copy introspection for the dashboard's Files / Diff
 * tabs. File-tree + content come straight from the bind-mounted
 * workspace; status + diff proxy to gitops (which runs git inside the
 * repo).
 */
export function registerCopyFilesRoutes(
  app: FastifyInstance,
  { workspaceRoot, gitops }: CopyFilesRoutesOptions,
): void {
  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/files',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isValidCopyName(req.params.name)) {
        return reply.code(400).send({ error: 'invalid copy' });
      }
      try {
        return await readCopyTree({
          copy: req.params.name,
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
  }>('/api/copies/:name/files/content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    const p = req.query.path;
    if (!p || typeof p !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      const r = await readCopyFile({
        copy: req.params.name,
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
  }>('/api/copies/:name/files/content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
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
      const r = await writeCopyFile({
        copy: req.params.name,
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
  }>('/api/copies/:name/files/upload', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    const targetRel = req.query.path ?? '';
    let targetDir: string;
    try {
      targetDir = await ensureCopyDir({
        copy: req.params.name,
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

  app.delete<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/copies/:name/files', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    const p = req.query.path;
    if (!p || typeof p !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      const r = await deleteCopyFile({
        copy: req.params.name,
        path: p,
        workspaceRoot,
      });
      if ('error' in r) return reply.code(404).send({ error: r.error });
      return reply.code(204).send();
    } catch (err) {
      app.log.warn({ err, name: req.params.name, path: p }, 'file delete failed');
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/copies/:name/files/raw', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    const p = req.query.path;
    if (!p || typeof p !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }
    try {
      const r = await statCopyFile({
        copy: req.params.name,
        path: p,
        workspaceRoot,
      });
      if ('error' in r) return reply.code(404).send({ error: r.error });
      const { type, inline } = rawContentMeta(r.name);
      // RFC 5987 encoding so names with spaces/unicode survive the header.
      const encodedName = encodeURIComponent(r.name);
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`,
        )
        .header('Content-Length', r.size)
        .type(type)
        .send(createReadStream(r.abs));
    } catch (err) {
      app.log.warn({ err, name: req.params.name, path: p }, 'raw file read failed');
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/status',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isValidCopyName(req.params.name)) {
        return reply.code(400).send({ error: 'invalid copy' });
      }
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyStatus(req.params.name);
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
  }>('/api/copies/:name/diff', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidCopyName(req.params.name)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    try {
      const r = await gitops.copyDiff(req.params.name, req.query.path);
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

/**
 * Content-type + disposition policy for raw file streaming. Only inert
 * raster images and PDF render inline; everything else (notably SVG and
 * HTML, which can carry scripts that would run on the dashboard's
 * origin) is forced to download as an attachment.
 */
function rawContentMeta(fileName: string): { type: string; inline: boolean } {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return { type: 'image/png', inline: true };
    case '.jpg':
    case '.jpeg':
      return { type: 'image/jpeg', inline: true };
    case '.gif':
      return { type: 'image/gif', inline: true };
    case '.webp':
      return { type: 'image/webp', inline: true };
    case '.pdf':
      return { type: 'application/pdf', inline: true };
    case '.svg':
      return { type: 'image/svg+xml', inline: false };
    case '.txt':
    case '.md':
      return { type: 'text/plain; charset=utf-8', inline: false };
    case '.csv':
      return { type: 'text/csv; charset=utf-8', inline: false };
    case '.json':
      return { type: 'application/json', inline: false };
    default:
      return { type: 'application/octet-stream', inline: false };
  }
}
