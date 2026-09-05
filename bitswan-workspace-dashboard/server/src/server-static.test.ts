import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { buildServer } from './server.js';

// The bundle the server serves is `<server>/../../client/dist`, i.e. the real
// one. These tests add a file to it after the server has started and take it
// away again — they never touch what the build produced.
const distAssets = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../client/dist/assets',
);
const added: string[] = [];

function addAssetAfterStart(name: string): string {
  mkdirSync(distAssets, { recursive: true });
  const file = path.join(distAssets, name);
  writeFileSync(file, 'export const rebuilt = true;\n');
  added.push(file);
  return `/assets/${name}`;
}

after(() => {
  for (const file of added) rmSync(file, { force: true });
});

/**
 * A dev-mode dashboard mounts the source tree, so `npm run build` writes new
 * content-hashed names while the server runs. Enumerating the bundle once at
 * registration leaves those files with no route: the SPA fallback answers with
 * index.html, and the browser refuses `text/html` as a module script — the app
 * then does not boot at all until someone restarts the container.
 */
test('a bundle rebuilt under a dev-mode server is served', async () => {
  process.env.BITSWAN_DEV_MODE = 'true';
  const app = await buildServer({ gitops: null });
  const url = addAssetAfterStart('probe-dev-mode.js');
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /javascript/);
  assert.match(res.body, /rebuilt/);
  await app.close();
});

test('a baked bundle keeps its enumerated routes', async () => {
  delete process.env.BITSWAN_DEV_MODE;
  delete process.env.BITSWAN_DASHBOARD_DEV_DIR;
  const app = await buildServer({ gitops: null });
  const url = addAssetAfterStart('probe-baked.js');
  const res = await app.inject({ method: 'GET', url });
  // Not an error — the SPA fallback answers, which is exactly why the browser
  // sees text/html where it wanted a module.
  assert.match(res.headers['content-type'] as string, /html/);
  await app.close();
});

test('the dev source dir alone is enough to serve a rebuild', async () => {
  delete process.env.BITSWAN_DEV_MODE;
  process.env.BITSWAN_DASHBOARD_DEV_DIR = '/workspace/dashboard-src';
  const app = await buildServer({ gitops: null });
  const url = addAssetAfterStart('probe-dev-dir.js');
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /javascript/);
  await app.close();
  delete process.env.BITSWAN_DASHBOARD_DEV_DIR;
});
