import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * What the host does with its one sidebar view: keeps it, feeds every page
 * from it, and hands task prompts to it.
 *
 * VS Code resolves a WebviewView once; hiding the sidebar or reloading the
 * window boots the webview's DOM again against the same provider, which is why
 * the conversation is still there when you come back. The host used to resolve
 * a fresh view per page load instead, and the symptoms were exactly what you
 * would predict: switching BPs and coming back started a new conversation, and
 * the old one kept running in the coding-agent container with nothing attached
 * to it — one orphaned `claude` per visit.
 *
 * The prompt hand-off rides on the same view. Dashboard buttons (Sync, Build
 * automation, Write tests) give the agent a job, which used to mean typing into
 * the terminal session; now it goes through the extension's own contributed
 * command. That command's name and argument order are the coupling, and
 * getting either wrong fails silently — the panel simply opens empty — so it
 * is pinned here against a stand-in extension driven over real IPC.
 */

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');
const TIMEOUT_MS = 20_000;

/**
 * Stand-in for the Claude Code extension: enough of it to observe what the
 * host does. It reports every `claude-vscode.editor.open` call back through
 * the webview, which is how these tests see the arguments the host chose.
 *
 * `withOpenCommand: false` builds one that never registers the command — the
 * shape of a future extension that renamed or dropped it.
 */
function extensionSource(withOpenCommand: boolean): string {
  return `
const vscode = require('vscode');
let resolves = 0;
let sidebar;
function activate() {
  ${
    withOpenCommand
      ? `vscode.commands.registerCommand('claude-vscode.editor.open', (...args) => {
    sidebar && sidebar.webview.postMessage({
      editorOpen: args,
      preferredLocation: vscode.workspace.getConfiguration('claudeCode').get('preferredLocation'),
    });
  });`
      : ''
  }
  vscode.window.registerWebviewViewProvider('claudeVSCodeSidebar', {
    resolveWebviewView(view) {
      resolves += 1;
      sidebar = view;
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
}

function extensionDir(withOpenCommand = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-reuse-'));
  fs.writeFileSync(path.join(dir, 'extension.js'), extensionSource(withOpenCommand));
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

  send(message: Record<string, unknown>): void {
    // eslint-disable-next-line no-restricted-syntax -- IPC boundary: the worker
    // types its own inbound messages, this side just has to get them across.
    this.child.send(message as Parameters<ChildProcess['send']>[0]);
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

async function started(withOpenCommand = true): Promise<Worker> {
  const worker = new Worker(extensionDir(withOpenCommand));
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

interface EditorOpenCall {
  editorOpen: unknown[];
  preferredLocation?: string;
}

/** The arguments the host passed to the extension's hand-off command. */
function editorOpenCalls(worker: Worker): EditorOpenCall[] {
  return worker
    .messages((m) => m.t === 'toWebview' && JSON.stringify(m.payload).includes('editorOpen'))
    .map((m) => m.payload as EditorOpenCall);
}

test('a task prompt is handed to the extension through its own command', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());
  await open(worker, 'page-a');

  worker.send({ t: 'prompt', id: 'task-1', text: 'Sync this business process' });
  await worker.until('prompted', (m) => m.t === 'prompted' && m.id === 'task-1');

  const [call] = editorOpenCalls(worker);
  assert.ok(call, 'the command must actually have been invoked');
  // (sessionId, initialPrompt, viewColumn, sessionGroupId, fullEditor, opts).
  // The prompt sits in the SECOND slot; putting it anywhere else opens an
  // empty panel and reports success.
  assert.equal(call.editorOpen[1], 'Sync this business process');
  assert.equal(call.editorOpen[0], null, 'no session id: it starts a new conversation');
  assert.equal(call.editorOpen[4], false, 'not a full editor');
  assert.deepEqual(call.editorOpen[5], { programmatic: 'honor-preferred-location' });
});

test('the sidebar is the surface the extension prefers', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());
  await open(worker, 'page-a');
  worker.send({ t: 'prompt', id: 'task-1', text: 'hello' });
  await worker.until('prompted', (m) => m.t === 'prompted' && m.id === 'task-1');

  // Without this the extension routes `honor-preferred-location` to an editor
  // panel, which this host does not implement — the prompt would open into
  // nothing and nobody would hear about it.
  assert.equal(editorOpenCalls(worker)[0]?.preferredLocation, 'sidebar');
});

test('a prompt with no view open is refused, not dropped', async (t) => {
  const worker = await started();
  t.after(() => worker.kill());

  worker.send({ t: 'prompt', id: 'task-1', text: 'hello' });
  const failure = await worker.until(
    'promptFailed',
    (m) => m.t === 'promptFailed' && m.id === 'task-1',
  );
  assert.match(failure.message ?? '', /no sidebar view/);
  assert.equal(editorOpenCalls(worker).length, 0);
});

test('an extension without that command says so', async (t) => {
  // The command is contributed, not part of the vscode API: a future build can
  // rename it. When that happens the hand-off must fail loudly rather than
  // leave the user staring at an empty composer.
  const worker = await started(false);
  t.after(() => worker.kill());
  await open(worker, 'page-a');

  worker.send({ t: 'prompt', id: 'task-1', text: 'hello' });
  const failure = await worker.until(
    'promptFailed',
    (m) => m.t === 'promptFailed' && m.id === 'task-1',
  );
  assert.match(failure.message ?? '', /claude-vscode\.editor\.open/);
});
