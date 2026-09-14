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

const opens = new Map<string, ResolvedWebview>();

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
        const registration = await activation;
        const view = await resolveWebviewView(registration, {
          extensionPath,
          resourceBase: raw.resourceBase,
        });
        opens.set(raw.id, view);
        const assetUris = await prefetchAssetUris(view);
        view.onWebviewMessage((payload) => send({ t: 'toWebview', id: raw.id, payload }));
        send({ t: 'opened', id: raw.id, html: view.html, assetUris });
      } catch (err) {
        send({ t: 'error', id: raw.id, message: String((err as Error)?.message ?? err) });
      }
      return;
    }
    if (raw.t === 'toExt') {
      opens.get(raw.id)?.sendFromWebview(raw.payload);
      return;
    }
    if (raw.t === 'close') {
      opens.delete(raw.id);
    }
  })();
});

process.on('disconnect', () => process.exit(0));
