import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { registerCopyFilesRoutes } from './copy-files.js';
import { formatByteSize, uploadLimitBytes } from '../services/copy-files.js';

const PRODUCTION_MULTIPART_FILE_SIZE_LIMIT = 5 * 1024 * 1024;
const PRODUCTION_MULTIPART_FILE_COUNT_LIMIT = 16;

const COPY = 'alice-acme-com';
const BP = 'invoice-processing';
const ATTACHMENTS_REL = `${BP}/attachments`;

const INJECTED_LIMIT = 2 * 1024 * 1024;

function multipartBody(
  files: { filename: string; content: Buffer }[],
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----bitswanAttachmentUploadSize';
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${f.filename}"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

describe('spec attachment uploads are bounded by free disk space, not a fixed 5 MiB (#407)', () => {
  let tmp: string;
  let workspaceRoot: string;
  let app: FastifyInstance;
  let appWithInjectedLimit: FastifyInstance;

  function attachmentsDir(): string {
    return path.join(workspaceRoot, 'copies', COPY, ATTACHMENTS_REL);
  }

  async function storedSize(filename: string): Promise<number | undefined> {
    const st = await fs.stat(path.join(attachmentsDir(), filename)).catch(() => undefined);
    return st?.size;
  }

  async function upload(
    target: FastifyInstance,
    files: { filename: string; content: Buffer }[],
  ): Promise<{ statusCode: number; body: string }> {
    const { headers, payload } = multipartBody(files);
    const res = await target.inject({
      method: 'POST',
      url: `/api/copies/${COPY}/files/upload?path=${encodeURIComponent(ATTACHMENTS_REL)}`,
      headers,
      payload,
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  async function buildApp(
    limit?: (dir: string) => Promise<number>,
  ): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    await instance.register(fastifyMultipart, {
      limits: {
        fileSize: PRODUCTION_MULTIPART_FILE_SIZE_LIMIT,
        files: PRODUCTION_MULTIPART_FILE_COUNT_LIMIT,
      },
    });
    registerCopyFilesRoutes(instance, {
      workspaceRoot,
      gitops: null,
      ...(limit ? { uploadLimitBytes: limit } : {}),
    });
    await instance.ready();
    return instance;
  }

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-upload-size-407-'));
    workspaceRoot = path.join(tmp, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'copies', COPY, BP), { recursive: true });

    app = await buildApp();
    appWithInjectedLimit = await buildApp(async () => INJECTED_LIMIT);
  });

  after(async () => {
    await app.close();
    await appWithInjectedLimit.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('stores an attachment well under the limit at its full size', async () => {
    const content = Buffer.alloc(1024 * 1024, 0x41);
    const r = await upload(app, [{ filename: 'small.zip', content }]);

    assert.equal(r.statusCode, 200, `unexpected status, body: ${r.body}`);
    assert.equal(await storedSize('small.zip'), content.byteLength);
  });

  it('accepts a zip attachment larger than the old 5 MiB cap', async () => {
    const content = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const r = await upload(app, [{ filename: 'gradesta-default.zip', content }]);

    assert.equal(r.statusCode, 200, `unexpected status, body: ${r.body}`);
  });

  it('stores a zip attachment larger than the old 5 MiB cap at its full size', async () => {
    const content = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const r = await upload(app, [{ filename: 'gradesta-full-size.zip', content }]);

    assert.notEqual(
      await storedSize('gradesta-full-size.zip'),
      PRODUCTION_MULTIPART_FILE_SIZE_LIMIT,
      'attachment was truncated to exactly the 5 MiB multipart cap',
    );
    assert.equal(await storedSize('gradesta-full-size.zip'), content.byteLength);
  });

  it('answers 413 with a readable reason when the attachment does not fit', async () => {
    const content = Buffer.alloc(INJECTED_LIMIT + 1024, 0x5a);
    const r = await upload(appWithInjectedLimit, [{ filename: 'too-big.zip', content }]);

    assert.equal(r.statusCode, 413, `unexpected status, body: ${r.body}`);
    const parsed = JSON.parse(r.body) as {
      error?: string;
      rejected?: string[];
      maxBytes?: number;
    };
    assert.deepEqual(parsed.rejected, ['too-big.zip']);
    assert.equal(parsed.maxBytes, INJECTED_LIMIT);
    assert.match(parsed.error ?? '', /too-big\.zip/);
    assert.match(parsed.error ?? '', /2 MB/);
    assert.match(parsed.error ?? '', /free disk space/i);
  });

  it('leaves no truncated file behind when the attachment does not fit', async () => {
    const content = Buffer.alloc(INJECTED_LIMIT + 1024, 0x5a);
    await upload(appWithInjectedLimit, [{ filename: 'no-remains.zip', content }]);

    assert.equal(
      await storedSize('no-remains.zip'),
      undefined,
      'a truncated attachment was left in the copy',
    );
    const leftovers = (await fs.readdir(attachmentsDir())).filter((n) =>
      n.includes('.upload-'),
    );
    assert.deepEqual(leftovers, [], 'a temp upload file was left in the copy');
  });

  it('keeps the attachments that do fit when a sibling in the same drop does not', async () => {
    const fits = Buffer.alloc(1024, 0x41);
    const doesNot = Buffer.alloc(INJECTED_LIMIT + 1024, 0x5a);
    const r = await upload(appWithInjectedLimit, [
      { filename: 'sibling-fits.zip', content: fits },
      { filename: 'sibling-too-big.zip', content: doesNot },
    ]);

    assert.equal(r.statusCode, 413, `unexpected status, body: ${r.body}`);
    assert.equal(await storedSize('sibling-fits.zip'), fits.byteLength);
    assert.equal(await storedSize('sibling-too-big.zip'), undefined);
  });

  it('reports the limit up front so the client can reject before uploading', async () => {
    const res = await appWithInjectedLimit.inject({
      method: 'GET',
      url: `/api/copies/${COPY}/files/upload-limit?path=${encodeURIComponent(ATTACHMENTS_REL)}`,
    });

    assert.equal(res.statusCode, 200, `unexpected status, body: ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), {
      maxBytes: INJECTED_LIMIT,
      maxBytesLabel: '2 MB',
    });
  });
});

describe('the attachment upload limit is 80% of free disk space (#407)', () => {
  it('derives the limit from statfs on the target directory', async () => {
    const st = await fs.statfs(os.tmpdir());
    const free = Number(st.bavail) * Number(st.bsize);

    assert.equal(await uploadLimitBytes(os.tmpdir()), Math.floor(free * 0.8));
  });

  it('leaves a fifth of the free space unclaimed', async () => {
    const limit = await uploadLimitBytes(os.tmpdir());
    const st = await fs.statfs(os.tmpdir());
    const free = Number(st.bavail) * Number(st.bsize);

    assert.ok(limit < free, 'the limit must not claim all free space');
    assert.ok(limit > free * 0.75, `limit ${limit} is not ~80% of ${free}`);
  });

  it('labels sizes the way the upload error and the limit endpoint report them', () => {
    assert.equal(formatByteSize(512), '512 B');
    assert.equal(formatByteSize(2 * 1024 * 1024), '2 MB');
    assert.equal(formatByteSize(5 * 1024 * 1024), '5 MB');
    assert.equal(formatByteSize(Math.round(3.4 * 1024 * 1024 * 1024)), '3.4 GB');
  });
});
