import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * One sidebar per host, reused by every page that opens it.
 *
 * VS Code resolves a WebviewView once; hiding the sidebar or reloading the
 * window boots the webview's DOM again against the same provider, which is why
 * the conversation is still there when you come back. The host used to resolve
 * a fresh view per page load instead, and the symptoms were exactly what you
 * would predict: switching BPs and coming back started a new conversation, and
 * the old one kept running in the coding-agent container with nothing attached
 * to it — one orphaned `claude` per visit.
 *
 * So these drive the real worker over IPC with a stand-in extension, and pin
 * the two properties that make a conversation survive a page load: the provider
 * is resolved once, and every attached page is fed from that one view.
 */

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');
const TIMEOUT_MS = 20_000;

const EXTENSION = `
const vscode = require('vscode');
let resolves = 0;
function activate() {
  vscode.window.registerWebviewViewProvider('claudeVSCodeSidebar', {
    resolveWebviewView(view) {
      resolves += 1;
      view.webview.html = '<html><head></head><body>resolves=' + resolves + '</body></html>';
      view.webview.onDidReceiveMessage((m) => {
        if (m && m.request && m.request.type === 'get_asset_uris') {
          view.webview.postMessage({
            type: 'from-extension',
            message: { requestId: m.requestId, response: { assetUris: { seeded: true } } },
          });
          return;
        }
        view.webview.postMessage({ echo: m });
      });
    },
  });
}
module.exports = { activate };
`;

function extensionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-reuse-'));
  fs.writeFileSync(path.join(dir, 'extension.js'), EXTENSION);
  return dir;
}

interface Message {
  t?: string;
  id?: string;
  html?: string;
  assetUris?: unknown;
  payload?: unknown;
  message?: string;
}

/** The worker as the sidebar service drives it: fork, IPC, wait for `ready`. */
class Worker {
  private readonly child: ChildProcess;
  private readonly seen: Message[] = [];
  private readonly waiters: { match: (m: Message) => boolean; resolve: () => void }[] = [];

  constructor(ext: string) {
    this.child = fork(WORKER, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        CLAUDE_EXTENSION_PATH: ext,
        SIDEBAR_WORKSPACE_FOLDER: ext,
        // Nothing here spawns an agent, but the host must not inherit a
        // wrapper path from the ambient environment either.
        SIDEBAR_CLAUDE_WRAPPER: '',
      },
    });
    this.child.on('message', (m: Message) => {
      this.seen.push(m);
      for (const w of [...this.waiters]) {
        if (!w.match(m)) continue;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    });
  }

  send(message: unknown): void {
    this.child.send(message);
  }

  messages(match: (m: Message) => boolean): Message[] {
    return this.seen.filter(match);
  }

  async until(what: string, match: (m: Message) => boolean): Promise<Message> {
    const already = this.seen.find(match);
    if (already) return already;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS);
      this.waiters.push({
        match,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
    return this.seen.find(match)!;
  }

  /** Give the worker a beat to do something we expect it NOT to do. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

async function started(): Promise<Worker> {
  const worker = new Worker(extensionDir());
  await worker.until('ready', (m) => m.t === 'ready');
  return worker;
}

async function open(worker: Worker, id: string): Promise<Message> {
  worker.send({ t: 'open', id, resourceBase: 'https://assets.invalid' });
  return worker.until(`open ${id}`, (m) => m.t === 'opened' && m.id === id);
}

test('a second page attaches to the view the first one opened', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());

  const first = await open(worker, 'page-a');
  const second = await open(worker, 'page-b');

  // The stand-in extension counts its own resolutions into the html, so this
  // asserts the provider was resolved once — not merely that the html matched.
  assert.match(first.html ?? '', /resolves=1/);
  assert.equal(second.html, first.html);
  assert.deepEqual(second.assetUris, first.assetUris);
});

test('every attached page is fed from that one view', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());
  await open(worker, 'page-a');
  await open(worker, 'page-b');

  worker.send({ t: 'toExt', id: 'page-a', payload: { hello: 'from a' } });
  await worker.until('echo to b', (m) => m.t === 'toWebview' && m.id === 'page-b');

  const echoes = worker.messages(
    (m) => m.t === 'toWebview' && JSON.stringify(m.payload).includes('from a'),
  );
  assert.deepEqual(
    echoes.map((m) => m.id).sort(),
    ['page-a', 'page-b'],
    'a message sent by one page must reach both, as one sidebar with two views would',
  );
});

test('closing a page leaves the view and its conversation alone', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());
  await open(worker, 'page-a');
  await open(worker, 'page-b');

  worker.send({ t: 'close', id: 'page-a' });
  worker.send({ t: 'toExt', id: 'page-b', payload: { hello: 'after close' } });
  await worker.until('echo to b', (m) =>
    m.t === 'toWebview' && m.id === 'page-b' && JSON.stringify(m.payload).includes('after close'),
  );

  assert.equal(
    worker.messages(
      (m) => m.t === 'toWebview' && m.id === 'page-a' && JSON.stringify(m.payload).includes('after close'),
    ).length,
    0,
    'a closed page must stop receiving',
  );

  // And the view is still the same one: reopening does not re-resolve.
  const reopened = await open(worker, 'page-c');
  assert.match(reopened.html ?? '', /resolves=1/);
});

test('a page that never attached cannot talk to the view', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());
  await open(worker, 'page-a');

  worker.send({ t: 'toExt', id: 'stranger', payload: { hello: 'unattached' } });
  await worker.settle();

  assert.equal(
    worker.messages((m) => m.t === 'toWebview' && JSON.stringify(m.payload).includes('unattached'))
      .length,
    0,
  );
});
