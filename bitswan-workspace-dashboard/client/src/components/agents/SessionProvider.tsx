import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SessionTerminal } from './SessionTerminal';

/**
 * Lifecycle of the coding-agent container, tracked at the provider level
 * so multiple AgentsTabs see the same state. Cold-starts are slow (docker
 * spawn + sshd boot + DNS register) so we kick the ensure call off as soon
 * as the dashboard knows the user cares about agents, and gate the Start
 * button on it.
 */
export type AgentStatus = 'idle' | 'pending' | 'ready' | 'failed';

/**
 * Per-Claude-conversation row tracked in app-level state. Sessions are
 * rendered at the SessionProvider level (not inside AgentsTab), and the
 * provider visually positions the rendering over whichever AgentsTab pane
 * is currently bound. That way users can switch between Deployments / a
 * different worktree / a different BP without losing their live agent
 * sessions — there is no remount.
 */
export type SessionKind = 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation';

/**
 * BP-scoped kinds that differ from a plain claude session only by the
 * canned prompt the server passes on first run. `startSession` accepts
 * these directly — no dedicated start helper needed per kind.
 */
export type BpSessionKind = 'claude' | 'write-tests' | 'automation';

export interface ActiveSession {
  /** Stable ID — doubles as the Claude session UUID we pass via SSH. */
  id: string;
  worktree: string;
  /** BP-scoped sessions set this; worktree-level (sync) sessions leave it null. */
  bp: string | null;
  kind: SessionKind;
  /**
   * Requirement id this session focuses on. Set for kind='requirement' so
   * the WS URL can be re-built on resume (we need to re-look-up the
   * description on the server).
   */
  requirementId?: string;
  startedAt: number;
  exited: boolean;
  /** True when started via Resume (claude --resume <uuid>). */
  resume: boolean;
}

interface Scope {
  worktree: string;
  bp: string;
}

interface SessionsContextValue {
  /** All sessions across every (worktree, bp) — the AgentsTab filters by scope. */
  sessions: ActiveSession[];

  /**
   * Start a BP-scoped session. `kind` defaults to a plain claude chat;
   * 'write-tests' / 'automation' run the same way but with the matching
   * canned prompt embedded by the server.
   */
  startSession(worktree: string, bp: string, kind?: BpSessionKind): string;
  /**
   * Start a worktree-level git-sync session. No BP — the auto-cmd cd's to
   * the worktree root and runs the bitswan-coding-agent vcs sync flow.
   */
  startSyncSession(worktree: string): string;
  /**
   * Start a focused session against a single requirement. The server reads
   * the requirement's description from the BP's testable-requirements.toml
   * and embeds it in Claude's prompt.
   */
  startRequirementSession(worktree: string, bp: string, requirementId: string): string;
  resumeSession(worktree: string, bp: string | null, claudeSessionId: string, kind: SessionKind): string;
  /** Called by SessionTerminal when its WS closes. */
  markExited(id: string): void;
  /** Subscribed-to by hooks that want to invalidate caches when a session ends. */
  onExit(handler: (session: ActiveSession) => void): () => void;

  /**
   * Which (worktree, bp) is currently being viewed. The provider shows
   * sessions in this scope on top of the bound pane; everything else stays
   * mounted but hidden.
   */
  currentScope: Scope | null;
  setCurrentScope(scope: Scope | null): void;

  /** Per-scope visible session id. */
  selectedFor(scope: Scope): string | null;
  setSelectedFor(scope: Scope, id: string | null): void;

  /**
   * The AgentsTab's pane DOM node. The provider tracks this element's
   * bounding rect and positions the always-mounted SessionsLayer to match.
   * Pass `null` to hide the layer entirely.
   */
  setPaneEl(el: HTMLElement | null): void;

  /** Current status of the upstream coding-agent container. */
  agentStatus: AgentStatus;
  /**
   * Force the warm-up call to (re-)run. Auto-fires once on the first
   * AgentsTab mount but the Start button calls it again if it lands in
   * `failed` state.
   */
  ensureAgent(): Promise<void>;
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error('useSessions must be used inside <SessionProvider>');
  }
  return ctx;
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16);
  return `${hex(0xffffffff)}-${hex(0xffff)}-4${hex(0xfff)}-${(
    8 + Math.floor(Math.random() * 4)
  ).toString(16)}${hex(0xfff)}-${hex(0xffffffffffff)}`;
}

function scopeKey(s: Scope): string {
  return `${s.worktree} ${s.bp}`;
}

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  // eslint-disable-next-line no-restricted-syntax -- null = not viewing an Agents tab
  const [currentScope, setCurrentScope] = useState<Scope | null>(null);
  const [selectedByScope, setSelectedByScope] = useState<Record<string, string | null>>({});
  // eslint-disable-next-line no-restricted-syntax -- null = no AgentsTab mounted
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no pane bounds yet
  const [paneRect, setPaneRect] = useState<PaneRect | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  // eslint-disable-next-line no-restricted-syntax -- imperative subscriber list
  const exitListeners = useRef<Set<(s: ActiveSession) => void>>(new Set());
  const ensureAgent = useCallback(async () => {
    // The coding-agent container is provisioned and started by the
    // automation-server during workspace init, so the dashboard no longer
    // needs to ask gitops to ensure it. The /ws/coding-agent path still
    // polls SSH readiness, which covers the case where the container is
    // briefly unavailable.
    setAgentStatus('ready');
  }, []);

  // Auto-warm when the user is *actually looking* at the Coding Agent tab —
  // not merely when the agent pane is mounted hidden in the background
  // (WorkspaceView keeps it mounted across tab switches). The hidden pane
  // has display:none and so a
  // zero-sized rect; only fire when the pane has real dimensions. Without
  // this, a fresh worktree visit would silently cold-start the coding-agent
  // container, Traefik would reconfigure mid-session, and Vite's HMR client
  // would reload the page from under the user.
  useEffect(() => {
    if (!paneRect || paneRect.width === 0 || paneRect.height === 0) return;
    if (agentStatus === 'idle') {
      void ensureAgent();
    }
  }, [paneRect, agentStatus, ensureAgent]);

  const setSelectedFor = useCallback((scope: Scope, id: string | null) => {
    const key = scopeKey(scope);
    setSelectedByScope((prev) => ({ ...prev, [key]: id }));
  }, []);

  const selectedFor = useCallback(
    (scope: Scope) => selectedByScope[scopeKey(scope)] ?? null,
    [selectedByScope],
  );

  const startSession = useCallback(
    (worktree: string, bp: string, kind: BpSessionKind = 'claude') => {
      const id = newSessionId();
      setSessions((prev) => [
        ...prev,
        {
          id,
          worktree,
          bp,
          kind,
          startedAt: Date.now(),
          exited: false,
          resume: false,
        },
      ]);
      setSelectedFor({ worktree, bp }, id);
      return id;
    },
    [setSelectedFor],
  );

  const startSyncSession = useCallback(
    (worktree: string) => {
      const id = newSessionId();
      setSessions((prev) => [
        ...prev,
        {
          id,
          worktree,
          bp: null,
          kind: 'sync',
          startedAt: Date.now(),
          exited: false,
          resume: false,
        },
      ]);
      // Sync sessions show up in every BP's Agents tab inside the worktree;
      // we don't select them per-scope automatically — the user will click
      // the sync row when they want to look at it. (If they were just
      // navigated to a fresh worktree without a BP, there's nothing to
      // select against either way.)
      return id;
    },
    [],
  );

  const startRequirementSession = useCallback(
    (worktree: string, bp: string, requirementId: string) => {
      const id = newSessionId();
      setSessions((prev) => [
        ...prev,
        {
          id,
          worktree,
          bp,
          kind: 'requirement',
          requirementId,
          startedAt: Date.now(),
          exited: false,
          resume: false,
        },
      ]);
      // Pre-select for the BP scope so flipping to the Agents tab lands on
      // the new session immediately.
      setSelectedFor({ worktree, bp }, id);
      return id;
    },
    [setSelectedFor],
  );

  const resumeSession = useCallback(
    (worktree: string, bp: string | null, claudeSessionId: string, kind: SessionKind) => {
      setSessions((prev) => {
        const live = prev.find(
          (s) =>
            s.id === claudeSessionId &&
            !s.exited &&
            s.worktree === worktree &&
            (s.bp ?? null) === bp,
        );
        if (live) return prev;
        return [
          ...prev,
          {
            id: claudeSessionId,
            worktree,
            bp,
            kind,
            startedAt: Date.now(),
            exited: false,
            resume: true,
          },
        ];
      });
      if (bp) setSelectedFor({ worktree, bp }, claudeSessionId);
      return claudeSessionId;
    },
    [setSelectedFor],
  );

  const markExited = useCallback((id: string) => {
    setSessions((prev) => {
      let exited: ActiveSession | undefined;
      const next = prev.map((s) => {
        if (s.id !== id) return s;
        const updated = { ...s, exited: true };
        exited = updated;
        return updated;
      });
      if (exited) {
        for (const fn of exitListeners.current) {
          try {
            fn(exited);
          } catch {
            // listener errors should not affect other listeners
          }
        }
      }
      return next;
    });
  }, []);

  const onExit = useCallback((handler: (s: ActiveSession) => void) => {
    exitListeners.current.add(handler);
    return () => {
      exitListeners.current.delete(handler);
    };
  }, []);

  // Track the AgentsTab pane's bounding rect so the always-mounted
  // SessionsLayer can be position:fixed-overlaid on top of it. ResizeObserver
  // catches the pane changing size; window scroll/resize catch viewport
  // shifts; the layout doesn't have its own scrolling parent, so this is
  // enough.
  useEffect(() => {
    if (!paneEl) {
      setPaneRect(null);
      return;
    }
    const update = () => {
      const r = paneEl.getBoundingClientRect();
      setPaneRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(paneEl);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [paneEl]);

  const value = useMemo<SessionsContextValue>(
    () => ({
      sessions,
      startSession,
      startSyncSession,
      startRequirementSession,
      resumeSession,
      markExited,
      onExit,
      currentScope,
      setCurrentScope,
      selectedFor,
      setSelectedFor,
      setPaneEl,
      agentStatus,
      ensureAgent,
    }),
    [
      sessions,
      startSession,
      startSyncSession,
      startRequirementSession,
      resumeSession,
      markExited,
      onExit,
      currentScope,
      selectedFor,
      setSelectedFor,
      agentStatus,
      ensureAgent,
    ],
  );

  return (
    <SessionsContext.Provider value={value}>
      {children}
      <SessionsLayer
        sessions={sessions}
        currentScope={currentScope}
        selectedByScope={selectedByScope}
        markExited={markExited}
        rect={paneRect}
      />
    </SessionsContext.Provider>
  );
}

/**
 * Renders every non-exited session as an absolutely-positioned terminal,
 * inside a fixed-position container that overlays the AgentsTab's pane
 * (`rect`). When no pane is bound the container is `display: none` — the
 * SessionTerminal trees stay mounted, just invisible, so their WebSockets
 * keep streaming while the user is on another view.
 *
 * The single container never changes parent or position-in-tree across
 * navigation, so React doesn't remount SessionTerminal — that's the whole
 * point of moving away from a target-switching portal.
 */
function SessionsLayer({
  sessions,
  currentScope,
  selectedByScope,
  markExited,
  rect,
}: {
  sessions: ActiveSession[];
  // eslint-disable-next-line no-restricted-syntax -- discriminated scope state
  currentScope: Scope | null;
  selectedByScope: Record<string, string | null>;
  markExited: (id: string) => void;
  // eslint-disable-next-line no-restricted-syntax -- null = nowhere to overlay
  rect: PaneRect | null;
}) {
  const containerStyle: React.CSSProperties = rect
    ? {
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        overflow: 'hidden',
        // pointer-events on the container itself: none, so clicks fall
        // through to the AgentsTab pane underneath when nothing is selected.
        // Individual SessionTerminals re-enable pointer events for themselves.
        pointerEvents: 'none',
      }
    : { display: 'none' };

  return (
    <div style={containerStyle}>
      {sessions
        .filter((s) => !s.exited)
        .map((s) => {
          // A session is "in scope" for the currently-viewed AgentsTab if
          // (a) it's a BP-scoped claude session matching this exact (worktree, bp), or
          // (b) it's a worktree-level sync session whose worktree matches —
          //     those surface in any BP's Agents tab inside the same worktree.
          const inScope =
            !!currentScope &&
            currentScope.worktree === s.worktree &&
            (s.kind === 'sync' || currentScope.bp === s.bp);
          // Selection is per (worktree, bp) so switching BPs preserves what
          // the user had selected in each. We always look up against the
          // *current* scope (not the session's intrinsic scope) — that lets
          // a user click a sync session while viewing BP-A and have it show
          // up there without polluting BP-B's selection.
          const selected =
            inScope &&
            !!currentScope &&
            selectedByScope[scopeKey(currentScope)] === s.id;
          return (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{
                display: selected ? 'block' : 'none',
                pointerEvents: selected ? 'auto' : 'none',
              }}
            >
              <SessionTerminal
                worktree={s.worktree}
                bp={s.bp}
                sessionId={s.id}
                kind={s.kind}
                resume={s.resume}
                hidden={!selected}
                onExit={() => markExited(s.id)}
                {...(s.requirementId ? { requirementId: s.requirementId } : {})}
              />
            </div>
          );
        })}
    </div>
  );
}
