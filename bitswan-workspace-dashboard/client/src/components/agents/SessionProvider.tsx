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
import { authHeader } from '@/lib/auth-token';
import { SessionTerminal } from './SessionTerminal';

/**
 * One live Claude conversation per (user, copy, BP) — that's the whole
 * model. The provider tracks that single session per scope, renders its
 * terminal at the app level (not inside AgentsTab), and visually positions
 * the rendering over whichever AgentsTab pane is currently bound. That way
 * users can switch between Deployments / a different copy / a different BP
 * without losing their live agent sessions — there is no remount.
 *
 * The canned flows (sync, per-requirement, write-tests, build-automation)
 * don't get sessions of their own: `sendPrompt` types their prompt into the
 * scope's running session, and only starts one (seeded with that prompt)
 * when none is running.
 */
export type SessionKind = 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation';

export interface ActiveSession {
  /** Stable ID — doubles as the Claude session UUID we pass via SSH. */
  id: string;
  copy: string;
  bp: string;
  /**
   * Selects the prompt a FRESH conversation is seeded with (the server
   * embeds it into the launch command). Resumed sessions carry no prompt,
   * so this is always 'claude' for them.
   */
  kind: SessionKind;
  /**
   * Requirement id this session focuses on. Set for kind='requirement' so
   * the WS URL carries it (the server looks up the description to build
   * the prompt).
   */
  requirementId?: string;
  startedAt: number;
  /** True when started via Resume (claude --resume <uuid>). */
  resume: boolean;
}

interface Scope {
  copy: string;
  bp: string;
}

/** Exit info forwarded to `onExit` listeners when a session's WS closes. */
export interface ExitedSession extends ActiveSession {
  exited: true;
  /**
   * WebSocket close code. 1008/1011 mean the server refused to spawn the
   * agent at all (bad request, not authenticated, coding-agent host
   * unreachable) — those aren't fixed by trying again. A normal 1000/1005
   * means the remote process ended.
   */
  exitCode?: number;
}

interface SessionsContextValue {
  /** The scope's live session, if any. */
  sessionFor(scope: Scope): ActiveSession | undefined;

  /**
   * Start the scope's session (fresh conversation, seeded with `kind`'s
   * prompt). No-op when one is already live — returns the running session's
   * id in that case.
   */
  startSession(copy: string, bp: string, kind?: SessionKind, requirementId?: string): string;
  /** Re-attach to an existing conversation (dtach socket / claude --resume). */
  resumeSession(copy: string, bp: string, claudeSessionId: string): string;
  /**
   * Hand a canned prompt to the scope's agent: typed (and submitted) into
   * the running session's terminal, or — when nothing is running — used to
   * seed a fresh session.
   */
  sendPrompt(copy: string, bp: string, kind: SessionKind, requirementId?: string): Promise<void>;

  /** Called by SessionTerminal when its WS closes. */
  markExited(id: string, exitCode?: number): void;
  /** Subscribed-to by hooks that want to invalidate caches when a session ends. */
  onExit(handler: (session: ExitedSession) => void): () => void;

  /**
   * Which (copy, bp) is currently being viewed. The provider shows this
   * scope's session on top of the bound pane; other scopes' sessions stay
   * mounted but hidden.
   */
  currentScope: Scope | null;
  setCurrentScope(scope: Scope | null): void;

  /**
   * The AgentsTab's pane DOM node. The provider tracks this element's
   * bounding rect and positions the always-mounted SessionsLayer to match.
   * Pass `null` to hide the layer entirely.
   */
  setPaneEl(el: HTMLElement | null): void;
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
  return `${s.copy} ${s.bp}`;
}

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // One session per scope key. An entry exists while its terminal is
  // mounted; markExited removes it (after notifying listeners), which
  // unmounts the terminal and lets the AgentsTab's autostart take over.
  const [sessions, setSessions] = useState<Record<string, ActiveSession>>({});
  // Mirror for async callbacks (sendPrompt) that need the current map
  // without re-subscribing.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // eslint-disable-next-line no-restricted-syntax -- null = not viewing an Agents tab
  const [currentScope, setCurrentScope] = useState<Scope | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no AgentsTab mounted
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no pane bounds yet
  const [paneRect, setPaneRect] = useState<PaneRect | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- imperative subscriber list
  const exitListeners = useRef<Set<(s: ExitedSession) => void>>(new Set());
  // Live PTY input writers, registered by each terminal while its WS is
  // open. This is the injection channel sendPrompt types prompts through.
  // eslint-disable-next-line no-restricted-syntax -- imperative registry
  const writersRef = useRef<Map<string, (data: string) => void>>(new Map());
  // Prompts sent while the scope's session was still connecting (no writer
  // yet). Flushed the moment its writer registers — the PTY buffers
  // type-ahead until Claude reads stdin, so nothing is lost.
  // eslint-disable-next-line no-restricted-syntax -- imperative queue, keyed by scope
  const pendingPromptsRef = useRef<Map<string, string[]>>(new Map());

  const sessionFor = useCallback(
    (scope: Scope) => sessions[scopeKey(scope)],
    [sessions],
  );

  const startSession = useCallback(
    (copy: string, bp: string, kind: SessionKind = 'claude', requirementId?: string) => {
      const key = scopeKey({ copy, bp });
      const existing = sessionsRef.current[key];
      if (existing) return existing.id;
      const id = newSessionId();
      setSessions((prev) => ({
        ...prev,
        [key]: {
          id,
          copy,
          bp,
          kind,
          ...(requirementId ? { requirementId } : {}),
          startedAt: Date.now(),
          resume: false,
        },
      }));
      return id;
    },
    [],
  );

  const resumeSession = useCallback(
    (copy: string, bp: string, claudeSessionId: string) => {
      const key = scopeKey({ copy, bp });
      const existing = sessionsRef.current[key];
      if (existing) return existing.id;
      setSessions((prev) => ({
        ...prev,
        [key]: {
          id: claudeSessionId,
          copy,
          bp,
          kind: 'claude',
          startedAt: Date.now(),
          resume: true,
        },
      }));
      return claudeSessionId;
    },
    [],
  );

  const sendPrompt = useCallback(
    async (copy: string, bp: string, kind: SessionKind, requirementId?: string) => {
      const key = scopeKey({ copy, bp });
      const live = sessionsRef.current[key];
      if (!live) {
        // Nothing running: seed a fresh conversation with the prompt (the
        // server embeds it into the launch command).
        startSession(copy, bp, kind, requirementId);
        return;
      }
      const params = new URLSearchParams({
        copy,
        bp,
        kind,
        ...(requirementId ? { requirement_id: requirementId } : {}),
      });
      const r = await fetch(`/api/coding-agent/prompt?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: await authHeader(),
      });
      if (!r.ok) throw new Error(`prompt fetch failed: HTTP ${r.status}`);
      const { prompt } = (await r.json()) as { prompt: string };
      // Bracketed paste so the TUI takes the text as one block, then CR to
      // submit — same channel as keystrokes, end to end.
      const data = `\x1b[200~${prompt}\x1b[201~\r`;
      const writer = writersRef.current.get(live.id);
      if (writer) {
        writer(data);
        return;
      }
      // Session exists but its WS hasn't opened yet — queue for the flush
      // in registerWriter rather than dropping the prompt.
      const queue = pendingPromptsRef.current.get(key) ?? [];
      queue.push(data);
      pendingPromptsRef.current.set(key, queue);
    },
    [startSession],
  );

  const registerWriter = useCallback(
    (id: string, write: ((data: string) => void) | null) => {
      if (!write) {
        writersRef.current.delete(id);
        return;
      }
      writersRef.current.set(id, write);
      const key = Object.keys(sessionsRef.current).find(
        (k) => sessionsRef.current[k]?.id === id,
      );
      if (!key) return;
      const queued = pendingPromptsRef.current.get(key);
      if (!queued) return;
      pendingPromptsRef.current.delete(key);
      for (const data of queued) write(data);
    },
    [],
  );

  const markExited = useCallback((id: string, exitCode?: number) => {
    writersRef.current.delete(id);
    // Drop any prompt queued for the dying session — its replacement starts
    // from the user's explicit action, not a stale injection.
    for (const [key, s] of Object.entries(sessionsRef.current)) {
      if (s.id === id) pendingPromptsRef.current.delete(key);
    }
    setSessions((prev) => {
      const key = Object.keys(prev).find((k) => prev[k]?.id === id);
      const session = key ? prev[key] : undefined;
      if (!key || !session) return prev;
      const exited: ExitedSession = {
        ...session,
        exited: true,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      for (const fn of exitListeners.current) {
        try {
          fn(exited);
        } catch {
          // listener errors should not affect other listeners
        }
      }
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const onExit = useCallback((handler: (s: ExitedSession) => void) => {
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
      sessionFor,
      startSession,
      resumeSession,
      sendPrompt,
      markExited,
      onExit,
      currentScope,
      setCurrentScope,
      setPaneEl,
    }),
    [
      sessionFor,
      startSession,
      resumeSession,
      sendPrompt,
      markExited,
      onExit,
      currentScope,
    ],
  );

  return (
    <SessionsContext.Provider value={value}>
      {children}
      <SessionsLayer
        sessions={sessions}
        currentScope={currentScope}
        markExited={markExited}
        registerWriter={registerWriter}
        rect={paneRect}
      />
    </SessionsContext.Provider>
  );
}

/**
 * Renders every scope's session as an absolutely-positioned terminal,
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
  markExited,
  registerWriter,
  rect,
}: {
  sessions: Record<string, ActiveSession>;
  // eslint-disable-next-line no-restricted-syntax -- discriminated scope state
  currentScope: Scope | null;
  markExited: (id: string, exitCode?: number) => void;
  registerWriter: (id: string, write: ((data: string) => void) | null) => void;
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
        // through to the AgentsTab pane underneath when nothing is shown.
        // The visible SessionTerminal re-enables pointer events for itself.
        pointerEvents: 'none',
      }
    : { display: 'none' };

  return (
    <div style={containerStyle}>
      {Object.values(sessions).map((s) => {
        const visible =
          !!currentScope && currentScope.copy === s.copy && currentScope.bp === s.bp;
        return (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{
              display: visible ? 'block' : 'none',
              pointerEvents: visible ? 'auto' : 'none',
            }}
          >
            <SessionTerminal
              copy={s.copy}
              bp={s.bp}
              sessionId={s.id}
              kind={s.kind}
              resume={s.resume}
              hidden={!visible}
              onExit={(info) => markExited(s.id, info.code)}
              onInputWriter={(write) => registerWriter(s.id, write)}
              {...(s.requirementId ? { requirementId: s.requirementId } : {})}
            />
          </div>
        );
      })}
    </div>
  );
}
