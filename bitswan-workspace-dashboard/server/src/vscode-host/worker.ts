import { activateExtension } from './host.js';
import { resolveWebviewView, type ResolvedWebview } from './api.js';

interface OpenMsg {
  t: 'open';
  id: string;
  resourceBase: string;
}
interface ToExtMsg {
  t: 'toExt';
  id: string;
  payload: unknown;
}
interface CloseMsg {
  t: 'close';
  id: string;
}
type Inbound = OpenMsg | ToExtMsg | CloseMsg;

const extensionPath = process.env.CLAUDE_EXTENSION_PATH ?? '';
const workspaceFolder = process.env.SIDEBAR_WORKSPACE_FOLDER ?? process.cwd();

/**
 * Settings handed to the extension at activation.
 *
 * `claudeProcessWrapper` moves the agent process out of this container and into
 * the coding-agent one, where `git`, `bitswan-coding-agent` and the gitops
 * credentials actually live (see ../../claude-process-wrapper). Without it the
 * panel runs an agent that can edit BP files and do nothing else with them.
 *
 * When the wrapper is set the far side owns the Claude identity — the agent's
 * session wrapper derives CLAUDE_CONFIG_DIR from the verified email, exactly as
 * the terminal agent did — so the user has one Claude account per workspace
 * rather than a second one per UI.
 */
function settingsForHost(): Record<string, unknown> {
  const wrapper = process.env.SIDEBAR_CLAUDE_WRAPPER;
  if (!wrapper) return {};
  return { 'claudeCode.claudeProcessWrapper': wrapper };
}

function send(message: unknown): void {
  process.send?.(message);
}

/**
 * The one sidebar view this host serves, and the pages currently showing it.
 *
 * VS Code resolves a WebviewView once and keeps it for the life of the
 * extension host; hiding the sidebar or reloading the window tears down the
 * webview's DOM and boots it again against the *same* provider state, which is
 * why a conversation is still there when you come back to it.
 *
 * We used to resolve a fresh view per page load. That handed the extension a
 * second, unrelated sidebar every time the user opened the tab — so every visit
 * started a new conversation, and the previous one was left running with
 * nothing attached to it (one orphaned `claude` in the coding-agent container
 * per visit, until the host was evicted half an hour later).
 *
 * So: resolve once, and let each page attach to it. Two browser tabs on the
 * same (user, copy, BP) see the same conversation, exactly as two views of one
 * VS Code sidebar would.
 */
interface Sidebar {
  view: ResolvedWebview;
  assetUris: unknown;
}

let sidebar: Promise<Sidebar> | undefined;
let resolved: Sidebar | undefined;
const attached = new Set<string>();

function ensureSidebar(resourceBase: string): Promise<Sidebar> {
  if (!sidebar) {
    const pending = (async (): Promise<Sidebar> => {
      const registration = await activation;
      const view = await resolveWebviewView(registration, { extensionPath, resourceBase });
      const assetUris = await prefetchAssetUris(view);
      // Registered once, for the life of the view: every attached page gets
      // every message, so a page that opens mid-conversation is fed by the
      // extension's own re-init handshake rather than by a replay we invent.
      view.onWebviewMessage((payload) => {
        for (const id of attached) send({ t: 'toWebview', id, payload });
      });
      const ready: Sidebar = { view, assetUris };
      resolved = ready;
      return ready;
    })();
    sidebar = pending;
    // A failed activation must not be cached forever: the next open retries.
    pending.catch(() => {
      if (sidebar === pending) sidebar = undefined;
    });
  }
  return sidebar;
}

const ASSET_PREFETCH_ID = 'bitswan-asset-prefetch';
const ASSET_PREFETCH_TIMEOUT_MS = 5_000;

function prefetchAssetUris(view: ResolvedWebview): Promise<unknown> {
  return new Promise((resolve) => {
    const finish = (value: unknown) => {
      clearTimeout(timer);
      off.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), ASSET_PREFETCH_TIMEOUT_MS);
    const off = view.onWebviewMessage((raw) => {
      const message = (raw as {
        message?: { requestId?: string; response?: { assetUris?: unknown } };
      })?.message;
      if (message?.requestId !== ASSET_PREFETCH_ID) return;
      finish(message.response?.assetUris);
    });
    view.sendFromWebview({
      type: 'request',
      requestId: ASSET_PREFETCH_ID,
      request: { type: 'get_asset_uris' },
    });
  });
}

const activation = activateExtension({
  extensionPath,
  workspaceFolder,
  settings: settingsForHost(),
}).then(
  (host) => {
    host.state.onOpenExternal = (url) => send({ t: 'openExternal', url });
    const registration =
      host.state.webviewViewProviders.find((r) => r.viewId === 'claudeVSCodeSidebar') ??
      host.state.webviewViewProviders[0];
    if (!registration) throw new Error('extension registered no webview view');
    return registration;
  },
);

activation.then(
  () => send({ t: 'ready' }),
  (err: unknown) => send({ t: 'fatal', message: String((err as Error)?.message ?? err) }),
);

process.on('message', (raw: Inbound) => {
  void (async () => {
    if (raw.t === 'open') {
      try {
        const { view, assetUris } = await ensureSidebar(raw.resourceBase);
        attached.add(raw.id);
        send({ t: 'opened', id: raw.id, html: view.html, assetUris });
      } catch (err) {
        send({ t: 'error', id: raw.id, message: String((err as Error)?.message ?? err) });
      }
      return;
    }
    if (raw.t === 'toExt') {
      // Synchronous on purpose: `open` has already resolved the view, and
      // routing through a promise here would reorder the webview's messages.
      if (attached.has(raw.id)) resolved?.view.sendFromWebview(raw.payload);
      return;
    }
    if (raw.t === 'close') {
      // The page went away; the view and its conversation stay.
      attached.delete(raw.id);
    }
  })();
});

process.on('disconnect', () => process.exit(0));
