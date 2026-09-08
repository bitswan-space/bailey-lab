import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { registerAutomationRoutes } from './automations.js';
import { registerBusinessProcessRoutes } from './business-processes.js';
import type { GitopsClient } from '../services/gitops.js';
import {
  BUFFERED_UPLOAD_CEILING_BYTES,
  FREE_DISK_REASON,
  MEMORY_CEILING_REASON,
  bufferedUploadLimit,
  describeLimit,
} from '../services/upload-limits.js';

const PRODUCTION_MULTIPART_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

const INJECTED_LIMIT = 2 * 1024 * 1024;
const OVER_LIMIT = INJECTED_LIMIT + 1024;
const ROOMY_LIMIT = 64 * 1024 * 1024;

function multipartBody(
  fields: Record<string, string>,
  file: { fieldname: string; filename: string; content: Buffer; type: string },
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----bitswanBufferedUpload';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

interface Upstream {
  dpaCalls: number;
  bundleCalls: number;
}

function stubGitops(seen: Upstream): GitopsClient {
  return {
    async firewallDpaUpload() {
      seen.dpaCalls += 1;
      return { ok: true, status: 200, body: { stored: 'ok', filename: 'dpa.pdf' } };
    },
    async createProcessFromBundle() {
      seen.bundleCalls += 1;
      return { ok: true, status: 200, body: { slug: 'restored' } };
    },
    async userRole() {
      return 'admin' as const;
    },
    async fwRole() {
      return 'admin' as const;
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
}

async function buildApp(
  seen: Upstream,
  maxBytes = INJECTED_LIMIT,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyMultipart, {
    limits: { fileSize: PRODUCTION_MULTIPART_FILE_SIZE_LIMIT, files: 16 },
  });
  const uploadLimit = async () => describeLimit(maxBytes, FREE_DISK_REASON);
  registerAutomationRoutes(app, {
    gitops: stubGitops(seen),
    workspaceRoot: os.tmpdir(),
    uploadLimit,
  });
  registerBusinessProcessRoutes(app, {
    gitops: stubGitops(seen),
    workspaceRoot: os.tmpdir(),
    uploadLimit,
  });
  await app.ready();
  return app;
}

describe('the DPA PDF upload is bounded by free disk space, not a fixed 5 MiB (#407)', () => {
  it('accepts a DPA PDF larger than the old 5 MiB cap', async () => {
    const seen: Upstream = { dpaCalls: 0, bundleCalls: 0 };
    const app = await buildApp(seen, ROOMY_LIMIT);
    const { headers, payload } = multipartBody(
      { stage: 'dev', host: 'api.example.com' },
      {
        fieldname: 'file',
        filename: 'dpa.pdf',
        content: Buffer.alloc(PRODUCTION_MULTIPART_FILE_SIZE_LIMIT + 1024, 0x25),
        type: 'application/pdf',
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/automations/business-processes/billing/firewall/dpa',
      headers,
      payload,
    });

    assert.equal(res.statusCode, 200, `unexpected status, body: ${res.body}`);
    assert.equal(seen.dpaCalls, 1);
    await app.close();
  });

  it('answers 413 naming the file and the limit, and forwards nothing upstream', async () => {
    const seen: Upstream = { dpaCalls: 0, bundleCalls: 0 };
    const app = await buildApp(seen);
    const { headers, payload } = multipartBody(
      { stage: 'dev', host: 'api.example.com' },
      {
        fieldname: 'file',
        filename: 'huge-dpa.pdf',
        content: Buffer.alloc(OVER_LIMIT, 0x25),
        type: 'application/pdf',
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/automations/business-processes/billing/firewall/dpa',
      headers,
      payload,
    });

    assert.equal(res.statusCode, 413, `unexpected status, body: ${res.body}`);
    const parsed = JSON.parse(res.body) as { error?: string; maxBytes?: number };
    assert.match(parsed.error ?? '', /huge-dpa\.pdf/);
    assert.match(parsed.error ?? '', /2 MB/);
    assert.match(parsed.error ?? '', /free disk space/i);
    assert.equal(parsed.maxBytes, INJECTED_LIMIT);
    assert.equal(seen.dpaCalls, 0, 'a truncated DPA reached gitops');
    await app.close();
  });
});

describe('the BP bundle upload shares the same limit and error (#407)', () => {
  it('answers 413 naming the file and the limit, and forwards nothing upstream', async () => {
    const seen: Upstream = { dpaCalls: 0, bundleCalls: 0 };
    const app = await buildApp(seen);
    const { headers, payload } = multipartBody(
      {},
      {
        fieldname: 'file',
        filename: 'huge-bundle.tar.gz',
        content: Buffer.alloc(OVER_LIMIT, 0x1f),
        type: 'application/gzip',
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/business-processes/from-bundle',
      headers,
      payload,
    });

    assert.equal(res.statusCode, 413, `unexpected status, body: ${res.body}`);
    const parsed = JSON.parse(res.body) as { error?: string; maxBytes?: number };
    assert.match(parsed.error ?? '', /huge-bundle\.tar\.gz/);
    assert.match(parsed.error ?? '', /2 MB/);
    assert.equal(parsed.maxBytes, INJECTED_LIMIT);
    assert.equal(seen.bundleCalls, 0, 'a truncated bundle reached gitops');
    await app.close();
  });

  it('accepts a bundle that fits', async () => {
    const seen: Upstream = { dpaCalls: 0, bundleCalls: 0 };
    const app = await buildApp(seen, ROOMY_LIMIT);
    const { headers, payload } = multipartBody(
      {},
      {
        fieldname: 'file',
        filename: 'bundle.tar.gz',
        content: Buffer.alloc(PRODUCTION_MULTIPART_FILE_SIZE_LIMIT + 1024, 0x1f),
        type: 'application/gzip',
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/business-processes/from-bundle',
      headers,
      payload,
    });

    assert.equal(res.statusCode, 200, `unexpected status, body: ${res.body}`);
    assert.equal(seen.bundleCalls, 1);
    await app.close();
  });
});

describe('uploads the server buffers in memory stay under a ceiling (#407)', () => {
  it('never offers more than the in-memory ceiling, however much disk is free', async () => {
    const limit = await bufferedUploadLimit(os.tmpdir());

    assert.ok(
      limit.maxBytes <= BUFFERED_UPLOAD_CEILING_BYTES,
      `${limit.maxBytes} exceeds the ${BUFFERED_UPLOAD_CEILING_BYTES} ceiling`,
    );
  });

  it('says which bound applied so the message is never misleading', async () => {
    const limit = await bufferedUploadLimit(os.tmpdir());

    assert.equal(
      limit.reason,
      limit.maxBytes === BUFFERED_UPLOAD_CEILING_BYTES
        ? MEMORY_CEILING_REASON
        : FREE_DISK_REASON,
    );
  });
});
