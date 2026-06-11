import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentSessionRow, type SessionRowData } from './AgentSessionRow';
import { useAgentSessions } from '@/hooks/useAgentSessions';
import { useSessions } from './SessionProvider';

// Lazy so the asciinema-player bundle only loads when a user clicks Play.
const AsciinemaPlayback = lazy(() =>
  import('./AsciinemaPlayback').then((m) => ({ default: m.AsciinemaPlayback })),
);

interface Props {
  worktree: string;
  bp: string;
  branch: string;
}

/**
 * Per-BP coding-agent session view: 300px sidebar with "Start agent session"
 * + a merged active/past list. The actual terminal rendering happens in
 * `SessionProvider`'s portal layer so sessions survive app-level navigation
 * (Deployments, different worktrees, different BPs) — this component just
 * shows the list, binds the portal target, and writes the per-scope
 * selection back into the provider.
 */
export function AgentsTab({ worktree, bp, branch }: Props) {
  // Destructure the stable callbacks so dependent effects don't re-run on
  // every sessions update — the context value object recomputes whenever
  // any session is added/removed/exited. If we depended on `ctx` directly,
  // the cleanup→setup cycle on every session change would flip the portal
  // target through null and tear down every live SessionTerminal.
  const {
    sessions: allSessions,
    startSession: startNewSession,
    resumeSession: resumeAnySession,
    onExit: subscribeOnExit,
    selectedFor: selectedForScope,
    setSelectedFor: setSelectedForScope,
    setCurrentScope,
    setPaneEl,
    agentStatus,
    ensureAgent,
  } = useSessions();
  const { sessions: past, refresh } = useAgentSessions(worktree, bp);
  // Asciinema replay is purely local — no need to live across navigation,
  // unlike active sessions. Reset to null whenever the (worktree, bp)
  // changes so a stale cast doesn't bleed into the new view.
  // eslint-disable-next-line no-restricted-syntax -- null = no past selection
  const [pastCast, setPastCast] = useState<string | null>(null);
  useEffect(() => {
    setPastCast(null);
  }, [worktree, bp]);

  // Bind this BP as the current scope + give the provider the pane DOM to
  // portal terminals into. Effect cleanup unbinds so when the user switches
  // away (Deployments, other worktree, etc.), the provider falls back to
  // the hidden host — terminals stay alive, just invisible.
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setCurrentScope({ worktree, bp });
    return () => {
      setCurrentScope(null);
    };
  }, [worktree, bp, setCurrentScope]);

  // Hand the provider our pane DOM so it can position the overlay
  // SessionsLayer over us. Setting via effect keeps it stable across
  // re-renders; cleanup sets null on unmount so the provider hides the
  // overlay when no AgentsTab is visible.
  useEffect(() => {
    setPaneEl(paneRef.current);
    return () => {
      setPaneEl(null);
    };
  }, [setPaneEl]);

  // Forward exit events from any session in this scope to the past-sessions
  // refresh so a just-ended live session shows up in the IDLE list without
  // waiting for the 5s poll tick.
  useEffect(() => {
    const unsubscribe = subscribeOnExit((s) => {
      if (s.worktree === worktree && s.bp === bp) refresh();
    });
    return unsubscribe;
  }, [subscribeOnExit, worktree, bp, refresh]);

  // Sessions in *this* scope: the current BP's claude sessions plus any
  // worktree-level sync sessions (which are bp-less and surface in every BP
  // of the worktree).
  const scopeSessions = useMemo(
    () =>
      allSessions.filter(
        (s) => s.worktree === worktree && (s.kind === 'sync' || s.bp === bp),
      ),
    [allSessions, worktree, bp],
  );

  const selectedId = selectedForScope({ worktree, bp });
  const selectActive = useCallback(
    (id: string) => {
      setSelectedForScope({ worktree, bp }, id);
      setPastCast(null);
    },
    [setSelectedForScope, worktree, bp],
  );

  const startSession = useCallback(async () => {
    // Make sure the coding-agent container is up before we let the user
    // open a session WebSocket. Without this the cold-start case races
    // ssh → container DNS, the WS closes with no output, the proxy reload
    // dance in dev triggers a page refresh, and the user is back to square
    // one. Retry once if a previous attempt failed.
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // ensureAgent already surfaces failure via agentStatus; the early
        // return below handles it from there.
      }
    }
    startNewSession(worktree, bp);
    setPastCast(null);
  }, [startNewSession, worktree, bp, agentStatus, ensureAgent]);

  const resumeSession = useCallback(
    async (claudeSessionId: string, kind: 'claude' | 'sync' | 'requirement') => {
      if (agentStatus === 'idle' || agentStatus === 'failed') {
        try {
          await ensureAgent();
        } catch {
          // see startSession
        }
      }
      resumeAnySession(
        worktree,
        kind === 'sync' ? null : bp,
        claudeSessionId,
        kind,
      );
      setPastCast(null);
    },
    [resumeAnySession, worktree, bp, agentStatus, ensureAgent],
  );

  // Index past rows' titles by Claude session id so live rows can inherit
  // the title once their conversation has one.
  const titleByClaudeId = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of past) {
      if (p.claudeSessionId && p.title) out.set(p.claudeSessionId, p.title);
    }
    return out;
  }, [past]);

  const rows = useMemo<SessionRowData[]>(() => {
    const liveClaudeIds = new Set<string>();
    const activeRows: SessionRowData[] = scopeSessions
      .filter((s) => !s.exited)
      .map((s) => {
        liveClaudeIds.add(s.id);
        const title = titleByClaudeId.get(s.id);
        const fallback =
          s.kind === 'sync'
            ? `Sync (${formatTime(s.startedAt)})`
            : s.kind === 'requirement'
              ? `${s.requirementId ?? 'Requirement'} (${formatTime(s.startedAt)})`
              : `New session (${formatTime(s.startedAt)})`;
        return {
          id: `active:${s.id}`,
          name: title || fallback,
          branch,
          lastActive: relativeFrom(s.startedAt),
          status: 'running' as const,
          kind: s.kind,
          claudeSessionId: s.id,
        };
      });
    // The agent's wrapper writes .meta.json at session *start*, so the poll
    // would surface a still-running session as a "past" row alongside the
    // in-memory active one. Drop past rows whose Claude session is currently
    // live — the active row already represents it.
    const pastRows: SessionRowData[] = past
      .filter((p) => !(p.claudeSessionId && liveClaudeIds.has(p.claudeSessionId)))
      .map((p) => {
        const kind: 'claude' | 'sync' | 'requirement' =
          p.kind === 'sync'
            ? 'sync'
            : p.kind === 'requirement'
              ? 'requirement'
              : 'claude';
        const fallback =
          kind === 'sync'
            ? `Sync (${formatPastTimestamp(p.timestamp)})`
            : kind === 'requirement'
              ? `Requirement (${formatPastTimestamp(p.timestamp)})`
              : `Claude session (${formatPastTimestamp(p.timestamp)})`;
        return {
          id: `past:${p.castFile || p.timestamp}`,
          name: p.title || fallback,
          branch,
          lastActive: relativeFromIso(p.timestamp),
          status: 'idle' as const,
          kind,
          castFile: p.castFile || undefined,
          ...(p.claudeSessionId ? { claudeSessionId: p.claudeSessionId } : {}),
        };
      });
    return [...activeRows, ...pastRows];
  }, [scopeSessions, past, branch, titleByClaudeId]);

  const showingPast = !!pastCast;
  const showingActive = !showingPast && !!selectedId;

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-white">
        <div className="flex flex-col gap-2.5 border-b border-border px-3.5 py-3">
          <Button
            onClick={startSession}
            disabled={agentStatus === 'pending'}
            className="w-full justify-center"
            size="sm"
          >
            <Plus className="size-3.5" />
            {agentStatus === 'pending' ? 'Starting coding agent…' : 'Start agent session'}
          </Button>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {agentStatus === 'failed' ? (
              <span className="text-destructive">
                Coding agent unavailable — click Start to retry.
              </span>
            ) : (
              <>
                {rows.length} {rows.length === 1 ? 'session' : 'sessions'}
              </>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-muted-foreground">
              No sessions yet.
            </div>
          ) : (
            rows.map((r) => {
              const isActiveSel =
                !showingPast && selectedId !== null && `active:${selectedId}` === r.id;
              const isPastSel =
                showingPast && r.castFile && `past:${r.castFile}` === r.id;
              const isSelected = Boolean(isActiveSel || isPastSel);
              const onRowClick = () => {
                if (r.id.startsWith('active:')) {
                  selectActive(r.id.slice('active:'.length));
                } else if (r.castFile) {
                  setPastCast(r.castFile);
                }
              };
              return (
                <AgentSessionRow
                  key={r.id}
                  s={r}
                  active={isSelected}
                  onClick={onRowClick}
                  {...(r.castFile
                    ? { onPlay: () => setPastCast(r.castFile!) }
                    : {})}
                  {...(r.id.startsWith('past:') && r.claudeSessionId
                    ? { onResume: (id: string) => resumeSession(id, r.kind) }
                    : {})}
                />
              );
            })
          )}
        </div>
      </aside>

      <main
        ref={paneRef}
        className="relative flex-1 overflow-hidden bg-zinc-50"
      >
        {showingPast && pastCast ? (
          <div className="absolute inset-0 z-10 bg-zinc-50">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Loading player…
                </div>
              }
            >
              <AsciinemaPlayback castFile={pastCast} />
            </Suspense>
          </div>
        ) : null}
        {!showingActive && !showingPast ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Start a session, or pick a past recording to play.
          </div>
        ) : null}
      </main>
    </div>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatPastTimestamp(iso: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relativeFrom(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function relativeFromIso(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return relativeFrom(t);
}
