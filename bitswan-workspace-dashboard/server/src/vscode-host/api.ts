import { EventEmitter as NodeEmitter } from 'node:events';
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { recordTouch } from './recorder.js';
import { makeStub } from './stub.js';

export interface Disposable {
  dispose(): void;
}

interface UriLike {
  fsPath?: string;
  path?: string;
}

function fsPathOf(uri: UriLike | string): string {
  if (typeof uri === 'string') return uri;
  return uri.fsPath ?? uri.path ?? '';
}

function disposable(fn: () => void): Disposable {
  return { dispose: fn };
}

class ShimEventEmitter<T> {
  private readonly bus = new NodeEmitter();

  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.bus.on('e', listener as (...a: unknown[]) => void);
    return disposable(() => this.bus.off('e', listener as (...a: unknown[]) => void));
  };

  fire(value: T): void {
    this.bus.emit('e', value);
  }

  dispose(): void {
    this.bus.removeAllListeners();
  }
}

class ShimUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(scheme: string, authority: string, p: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): ShimUri {
    return new ShimUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${q}${f}`;
  }

  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }

  static file(p: string): ShimUri {
    return new ShimUri('file', '', p);
  }

  static parse(value: string): ShimUri {
    try {
      const u = new URL(value);
      return new ShimUri(u.protocol.replace(/:$/, ''), u.host, u.pathname, u.search.replace(/^\?/, ''), u.hash.replace(/^#/, ''));
    } catch {
      return ShimUri.file(value);
    }
  }

  static joinPath(base: ShimUri, ...segments: string[]): ShimUri {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }

  static from(parts: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): ShimUri {
    return new ShimUri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '', parts.fragment ?? '');
  }
}

class ShimPosition {
  constructor(readonly line: number, readonly character: number) {}
}

class ShimRange {
  readonly start: ShimPosition;
  readonly end: ShimPosition;
  constructor(a: ShimPosition | number, b: ShimPosition | number, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      this.start = new ShimPosition(a, b);
      this.end = new ShimPosition(c ?? a, d ?? b);
    } else {
      this.start = a as ShimPosition;
      this.end = b as ShimPosition;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

class ShimSelection extends ShimRange {
  readonly anchor: ShimPosition;
  readonly active: ShimPosition;
  constructor(a: ShimPosition | number, b: ShimPosition | number, c?: number, d?: number) {
    super(a, b, c, d);
    this.anchor = this.start;
    this.active = this.end;
  }
}

export interface WebviewViewProviderRegistration {
  viewId: string;
  provider: unknown;
  options?: unknown;
}

export interface HostState {
  workspaceFolder: string;
  configuration: Map<string, unknown>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  webviewViewProviders: WebviewViewProviderRegistration[];
  messagesToUser: { level: string; message: string }[];
}

export function createHostState(workspaceFolder: string): HostState {
  return {
    workspaceFolder,
    configuration: new Map(),
    commands: new Map(),
    webviewViewProviders: [],
    messagesToUser: [],
  };
}

function configurationSection(state: HostState, section: string | undefined) {
  const prefix = section ? `${section}.` : '';
  return {
    get: (key: string, fallback?: unknown) => {
      const v = state.configuration.get(`${prefix}${key}`);
      return v === undefined ? fallback : v;
    },
    has: (key: string) => state.configuration.has(`${prefix}${key}`),
    inspect: () => undefined,
    update: async (key: string, value: unknown) => {
      state.configuration.set(`${prefix}${key}`, value);
    },
  };
}

export function buildVscodeApi(state: HostState): Record<string, unknown> {
  const onDidChangeConfiguration = new ShimEventEmitter<unknown>();

  const commands = {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      recordTouch('commands.registerCommand', 'call', true);
      state.commands.set(id, handler);
      return disposable(() => state.commands.delete(id));
    },
    registerTextEditorCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      recordTouch('commands.registerTextEditorCommand', 'call', true);
      state.commands.set(id, handler);
      return disposable(() => state.commands.delete(id));
    },
    executeCommand: async (id: string, ...args: unknown[]) => {
      recordTouch(`commands.executeCommand(${id})`, 'call', true);
      const own = state.commands.get(id);
      if (own) return own(...args);
      return undefined;
    },
    getCommands: async () => [...state.commands.keys()],
  };

  const window = {
    registerWebviewViewProvider: (viewId: string, provider: unknown, options?: unknown) => {
      recordTouch('window.registerWebviewViewProvider', 'call', true);
      state.webviewViewProviders.push({ viewId, provider, options });
      return disposable(() => {
        state.webviewViewProviders = state.webviewViewProviders.filter((r) => r.viewId !== viewId);
      });
    },
    showInformationMessage: async (message: string) => {
      recordTouch('window.showInformationMessage', 'call', true);
      state.messagesToUser.push({ level: 'info', message: String(message) });
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      recordTouch('window.showWarningMessage', 'call', true);
      state.messagesToUser.push({ level: 'warn', message: String(message) });
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      recordTouch('window.showErrorMessage', 'call', true);
      state.messagesToUser.push({ level: 'error', message: String(message) });
      return undefined;
    },
    createOutputChannel: (name: string) => {
      recordTouch('window.createOutputChannel', 'call', true);
      const noop = () => undefined;
      return {
        name,
        logLevel: 2,
        onDidChangeLogLevel: new ShimEventEmitter<unknown>().event,
        append: noop,
        appendLine: noop,
        clear: noop,
        show: noop,
        hide: noop,
        replace: noop,
        dispose: noop,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
      };
    },
    activeTextEditor: undefined,
    visibleTextEditors: [] as unknown[],
    terminals: [] as unknown[],
    activeTerminal: undefined,
    activeNotebookEditor: undefined,
    tabGroups: {
      all: [] as unknown[],
      activeTabGroup: { tabs: [] as unknown[], isActive: true, viewColumn: 1, activeTab: undefined },
      close: async () => true,
      onDidChangeTabs: new ShimEventEmitter<unknown>().event,
      onDidChangeTabGroups: new ShimEventEmitter<unknown>().event,
    },
    onDidChangeActiveTextEditor: new ShimEventEmitter<unknown>().event,
    onDidChangeVisibleTextEditors: new ShimEventEmitter<unknown>().event,
    onDidChangeTextEditorSelection: new ShimEventEmitter<unknown>().event,
    onDidChangeActiveColorTheme: new ShimEventEmitter<unknown>().event,
    onDidChangeTerminalShellIntegration: new ShimEventEmitter<unknown>().event,
    onDidStartTerminalShellExecution: new ShimEventEmitter<unknown>().event,
    onDidEndTerminalShellExecution: new ShimEventEmitter<unknown>().event,
    onDidCloseTerminal: new ShimEventEmitter<unknown>().event,
  };

  const workspace = {
    workspaceFolders: [
      { uri: ShimUri.file(state.workspaceFolder), name: path.basename(state.workspaceFolder), index: 0 },
    ],
    rootPath: state.workspaceFolder,
    workspaceFile: undefined,
    name: path.basename(state.workspaceFolder),
    textDocuments: [] as unknown[],
    getConfiguration: (section?: string) => {
      recordTouch('workspace.getConfiguration', 'call', true);
      return configurationSection(state, section);
    },
    onDidChangeConfiguration: onDidChangeConfiguration.event,
    asRelativePath: (target: unknown) => {
      recordTouch('workspace.asRelativePath', 'call', true);
      const p = typeof target === 'string' ? target : String((target as { fsPath?: string })?.fsPath ?? '');
      return path.relative(state.workspaceFolder, p) || p;
    },
    getWorkspaceFolder: () => workspace.workspaceFolders[0],
    onDidChangeWorkspaceFolders: new ShimEventEmitter<unknown>().event,
    onDidChangeTextDocument: new ShimEventEmitter<unknown>().event,
    onDidSaveTextDocument: new ShimEventEmitter<unknown>().event,
    onDidCloseTextDocument: new ShimEventEmitter<unknown>().event,
    onDidOpenTextDocument: new ShimEventEmitter<unknown>().event,
    onWillSaveTextDocument: new ShimEventEmitter<unknown>().event,
    registerFileSystemProvider: () => {
      recordTouch('workspace.registerFileSystemProvider', 'call', true);
      return disposable(() => undefined);
    },
    registerTextDocumentContentProvider: () => {
      recordTouch('workspace.registerTextDocumentContentProvider', 'call', true);
      return disposable(() => undefined);
    },
    openTextDocument: async () => {
      recordTouch('workspace.openTextDocument', 'call', true);
      return undefined;
    },
    findFiles: async () => {
      recordTouch('workspace.findFiles', 'call', true);
      return [];
    },
    applyEdit: async () => {
      recordTouch('workspace.applyEdit', 'call', true);
      return false;
    },
    // A real filesystem, not stubs. The extension writes pasted images through
    // workspace.fs before handing the path to the CLI; no-op writes are why an
    // attached image reached the model but the agent then reported it "isn't on
    // disk" and offered to hand-author an SVG instead.
    fs: {
      readFile: async (uri: UriLike) => new Uint8Array(await nodeFs.readFile(fsPathOf(uri))),
      writeFile: async (uri: UriLike, content: Uint8Array) => {
        const target = fsPathOf(uri);
        await nodeFs.mkdir(path.dirname(target), { recursive: true });
        await nodeFs.writeFile(target, content);
      },
      stat: async (uri: UriLike) => {
        const st = await nodeFs.stat(fsPathOf(uri));
        return {
          type: st.isDirectory() ? 2 : st.isSymbolicLink() ? 64 : 1,
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size,
        };
      },
      readDirectory: async (uri: UriLike) => {
        const entries = await nodeFs.readdir(fsPathOf(uri), { withFileTypes: true });
        return entries.map((e) => [e.name, e.isDirectory() ? 2 : e.isSymbolicLink() ? 64 : 1]);
      },
      createDirectory: async (uri: UriLike) => {
        await nodeFs.mkdir(fsPathOf(uri), { recursive: true });
      },
      delete: async (uri: UriLike, options?: { recursive?: boolean }) => {
        await nodeFs.rm(fsPathOf(uri), { recursive: Boolean(options?.recursive), force: true });
      },
      rename: async (from: UriLike, to: UriLike) => {
        await nodeFs.rename(fsPathOf(from), fsPathOf(to));
      },
      copy: async (from: UriLike, to: UriLike) => {
        await nodeFs.copyFile(fsPathOf(from), fsPathOf(to));
      },
      isWritableFileSystem: () => true,
    },
  };

  const env = {
    appName: 'Bitswan Bailey',
    appHost: 'bitswan-dashboard',
    uriScheme: 'bitswan',
    language: 'en',
    machineId: 'bitswan-dashboard',
    sessionId: `bitswan-${Date.now()}`,
    remoteName: undefined,
    shell: '/bin/bash',
    uiKind: 1,
    isTelemetryEnabled: false,
    isNewAppInstall: false,
    clipboard: {
      readText: async () => '',
      writeText: async () => undefined,
    },
    openExternal: async () => true,
  };

  return {
    version: '1.94.0',
    Uri: ShimUri,
    Position: ShimPosition,
    Range: ShimRange,
    Selection: ShimSelection,
    EventEmitter: ShimEventEmitter,
    Disposable: Object.assign(
      class ShimDisposable {
        constructor(private readonly fn: () => void = () => undefined) {}
        dispose(): void {
          this.fn();
        }
      },
      { from: (...items: Disposable[]) => disposable(() => items.forEach((i) => i.dispose())) },
    ),
    commands,
    window,
    workspace,
    env,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    languages: {
      getDiagnostics: () => [],
      onDidChangeDiagnostics: new ShimEventEmitter<unknown>().event,
      registerCodeLensProvider: () => disposable(() => undefined),
    },
    extensions: {
      getExtension: () => undefined,
      all: [] as unknown[],
      onDidChange: new ShimEventEmitter<unknown>().event,
    },
    FileSystemError: makeStub('FileSystemError'),
    RelativePattern: makeStub('RelativePattern'),
    WorkspaceEdit: makeStub('WorkspaceEdit'),
    NotebookEdit: makeStub('NotebookEdit'),
    NotebookCellData: makeStub('NotebookCellData'),
    NotebookRange: makeStub('NotebookRange'),
    NotebookCellOutputItem: makeStub('NotebookCellOutputItem'),
    TabInputText: makeStub('TabInputText'),
    TabInputTextDiff: makeStub('TabInputTextDiff'),
    TabInputWebview: makeStub('TabInputWebview'),
    __shimState: state,
  };
}

export interface ResolvedWebview {
  viewId: string;
  html: string;
  options: unknown;
  postToWebview: (message: unknown) => void;
  onWebviewMessage: (listener: (message: unknown) => void) => Disposable;
  sendFromWebview: (message: unknown) => void;
}

export async function resolveWebviewView(
  registration: WebviewViewProviderRegistration,
  opts: { extensionPath: string; resourceBase: string },
): Promise<ResolvedWebview> {
  const fromWebview = new ShimEventEmitter<unknown>();
  const toWebview = new ShimEventEmitter<unknown>();
  let html = '';

  const webview = {
    options: {} as Record<string, unknown>,
    cspSource: opts.resourceBase,
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
    },
    asWebviewUri: (uri: { path?: string; fsPath?: string }) => {
      const p = uri.path ?? uri.fsPath ?? '';
      const rel = path.relative(opts.extensionPath, p) || path.basename(p);
      const target = `${opts.resourceBase}/${rel.split(path.sep).join('/')}`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return ShimUri.parse(target);
      return {
        scheme: '',
        authority: '',
        path: target,
        query: '',
        fragment: '',
        fsPath: target,
        toString: () => target,
        toJSON: () => target,
      };
    },
    postMessage: async (message: unknown) => {
      toWebview.fire(message);
      return true;
    },
    onDidReceiveMessage: fromWebview.event,
  };

  const view = {
    viewType: registration.viewId,
    webview,
    visible: true,
    title: undefined as string | undefined,
    description: undefined as string | undefined,
    badge: undefined,
    show: () => undefined,
    onDidDispose: new ShimEventEmitter<unknown>().event,
    onDidChangeVisibility: new ShimEventEmitter<unknown>().event,
  };

  const provider = registration.provider as {
    resolveWebviewView?: (v: unknown, c: unknown, t: unknown) => unknown;
  };
  if (typeof provider.resolveWebviewView !== 'function') {
    throw new Error(`provider for ${registration.viewId} has no resolveWebviewView`);
  }
  await provider.resolveWebviewView(
    view,
    { state: undefined },
    { isCancellationRequested: false, onCancellationRequested: new ShimEventEmitter<unknown>().event },
  );

  return {
    viewId: registration.viewId,
    html,
    options: webview.options,
    postToWebview: (m) => fromWebview.fire(m),
    onWebviewMessage: (l) => toWebview.event(l),
    sendFromWebview: (m) => fromWebview.fire(m),
  };
}
