import Module from 'node:module';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVscodeApi, createHostState, type HostState } from './api.js';
import { recordTouch } from './recorder.js';
import { makeStub } from './stub.js';

export interface ExtensionHost {
  state: HostState;
  api: Record<string, unknown>;
  deactivate?: () => unknown;
}

function recordingNamespace(name: string, value: object): object {
  return new Proxy(value, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      const key = `${name}.${String(prop)}`;
      if (prop in target) {
        recordTouch(key, 'get', true);
        return Reflect.get(target, prop);
      }
      recordTouch(key, 'get', false);
      return makeStub(key);
    },
    has: (target, prop) => prop in target,
    ownKeys: (target) => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (target, prop) => Reflect.getOwnPropertyDescriptor(target, prop),
  });
}

function proxiedApi(api: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api)) {
    const isPlainNamespace =
      typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
    out[key] = isPlainNamespace ? recordingNamespace(key, value as object) : value;
  }
  return out;
}


function fileMemento(file: string, defaults: Record<string, unknown> = {}) {
  let store: Record<string, unknown>;
  try {
    store = { ...defaults, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) };
  } catch {
    store = { ...defaults };
  }
  const flush = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
      fs.renameSync(tmp, file);
    } catch {
      return;
    }
  };
  return {
    keys: () => Object.keys(store),
    get: (k: string, fallback?: unknown) => (k in store ? store[k] : fallback),
    update: async (k: string, v: unknown) => {
      if (v === undefined) delete store[k];
      else store[k] = v;
      flush();
    },
    setKeysForSync: () => undefined,
  };
}

function workspaceSlug(workspaceFolder: string): string {
  return crypto.createHash('sha256').update(workspaceFolder).digest('hex').slice(0, 12);
}

function extensionContext(
  extensionDir: string,
  storageRoot: string,
  api: Record<string, unknown>,
  workspaceFolder: string,
) {
  const Uri = api.Uri as { file: (p: string) => unknown };
  return {
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: extensionDir,
    extensionUri: Uri.file(extensionDir),
    extensionMode: 1,
    globalState: fileMemento(path.join(storageRoot, 'global-state.json'), {
      showTerminalBanner: false,
    }),
    workspaceState: fileMemento(
      path.join(storageRoot, `workspace-state-${workspaceSlug(workspaceFolder)}.json`),
    ),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    globalStorageUri: Uri.file(path.join(storageRoot, 'global')),
    storageUri: Uri.file(path.join(storageRoot, 'workspace')),
    logUri: Uri.file(path.join(storageRoot, 'logs')),
    globalStoragePath: path.join(storageRoot, 'global'),
    storagePath: path.join(storageRoot, 'workspace'),
    logPath: path.join(storageRoot, 'logs'),
    asAbsolutePath: (rel: string) => path.join(extensionDir, rel),
    environmentVariableCollection: {
      persistent: false,
      replace: () => undefined,
      append: () => undefined,
      prepend: () => undefined,
      get: () => undefined,
      forEach: () => undefined,
      delete: () => undefined,
      clear: () => undefined,
      getScoped: () => undefined,
    },
    extension: { id: 'anthropic.claude-code', packageJSON: {}, extensionKind: 2, isActive: true },
  };
}

export async function activateExtension(opts: {
  extensionPath: string;
  workspaceFolder: string;
  storageRoot?: string;
}): Promise<ExtensionHost> {
  const state = createHostState(opts.workspaceFolder);
  const api = buildVscodeApi(state);
  const shim = proxiedApi(api);

  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  loader._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return shim;
    return originalLoad.call(this, request, parent, isMain);
  };

  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const storageRoot =
    opts.storageRoot ??
    (configDir
      ? path.join(configDir, 'vscode-host')
      : fs.mkdtempSync(path.join(os.tmpdir(), 'bitswan-vscode-host-')));
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const ctx = extensionContext(opts.extensionPath, storageRoot, api, opts.workspaceFolder);

  try {
    const requireFromHost = createRequire(import.meta.url);
    const entry = path.join(opts.extensionPath, 'extension.js');
    const mod = requireFromHost(entry) as {
      activate?: (c: unknown) => unknown;
      deactivate?: () => unknown;
    };
    if (typeof mod.activate !== 'function') {
      throw new Error('extension.js exports no activate()');
    }
    await mod.activate(ctx);
    return { state, api, ...(mod.deactivate ? { deactivate: mod.deactivate } : {}) };
  } finally {
    loader._load = originalLoad;
  }
}
