import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Folder, GitPullRequest, Loader2, MessageSquare, Plus } from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { ContainersPane } from '@/components/agents/ContainersPane';
import { Button } from '@/components/ui/button';
import { useSessions } from '@/components/agents/SessionProvider';
import { useAgentSessions } from '@/hooks/useAgentSessions';
import { cn } from '@/lib/utils';
import { useUrlEnum, useUrlFlag } from '@/lib/urlState';

interface AgentFilesTabProps {
  copy: string;
  bp: string;
  branch: string;
  /** True only when the Coding Agent tab is the active tab (the pane stays
   *  mounted-but-hidden otherwise). Gates auto-reattach so we don't spin up
   *  sessions for BPs the user is only browsing on other tabs. */
  tabVisible?: boolean;
}

type Sub = 'chat' | 'files' | 'containers';
const SUBS: Sub[] = ['chat', 'files', 'containers'];

/**
 * The Agents screen, per the wireframe (Workspace Dashboard → Agents): one
 * agent per business process — no session list. A header chip shows the
 * agent (status dot + name), then Chat / Files sub-tabs; the right-hand
 * ENVIRONMENT panel lives in WorkspaceView.
 *
 *   - Chat  → the live coding-agent terminal. It renders in SessionProvider's
 *     portal layer over this pane, so it must stay mounted (we hide it, not
 *     unmount it, when Files is active) or the running terminal is torn down.
 *   - Files → the copy file browser with a Diff toggle.
 *
 * (Plan, Notes, and the Playwright Browser pane from the wireframe are
 * intentionally not built.)
 */
export function AgentFilesTab({ copy, bp, branch: _branch, tabVisible = true }: AgentFilesTabProps) {
  const {
    sessions: allSessions,
    startSession,
    resumeSession,
    setCurrentScope,
    setPaneEl,
    selectedFor,
    setSelectedFor,
    agentStatus,
    ensureAgent,
  } = useSessions();
  const { sessions: past, loading: pastLoading } = useAgentSessions(copy, bp);

  // Sub-tab and the Diff toggle live in the URL so the Agents view is
  // deep-linkable (?sub=files&diff=1).
  const [sub, setSub] = useUrlEnum('sub', SUBS, 'chat');
  const [showDiff, setShowDiff] = useUrlFlag('diff');
  // Turn Diff off when the user changes sub-tab or copy — but NOT on the
  // initial mount, so a pasted ?diff=1 link is honoured.
  const diffResetReady = useRef(false);
  useEffect(() => {
    if (!diffResetReady.current) {
      diffResetReady.current = true;
      return;
    }
    setShowDiff(false);
  }, [sub, copy, setShowDiff]);

  // Bind this BP as the active scope and hand the provider the Chat pane so
  // it can portal the terminal over it. Cleanup unbinds so terminals stay
  // alive (just hidden) when the user navigates away.
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setCurrentScope({ copy, bp });
    return () => setCurrentScope(null);
  }, [copy, bp, setCurrentScope]);
  useEffect(() => {
    setPaneEl(paneRef.current);
    return () => setPaneEl(null);
  }, [setPaneEl]);

  // The BP's live sessions. One agent per BP: the selected active session, or
  // the first running one. Sync sessions are copy-level and bp-less.
  const active = useMemo(
    () =>
      allSessions.filter(
        (s) =>
          !s.exited &&
          s.copy === copy &&
          (s.bp === bp || (s.kind === 'sync' && s.bp === null)),
      ),
    [allSessions, copy, bp],
  );
  const selectedId = selectedFor({ copy, bp });
  const agent = active.find((s) => s.id === selectedId) ?? active[0];

  // Keep the scope selection pointed at the live agent so the provider shows
  // the right terminal.
  useEffect(() => {
    if (agent && agent.id !== selectedId) {
      setSelectedFor({ copy, bp }, agent.id);
    }
  }, [agent, selectedId, setSelectedFor, copy, bp]);

  // Auto-reattach: the agent runs server-side inside `dtach` keyed by the
  // Claude session UUID, so it survives a browser close / hard refresh — but
  // the client's live-session list is in-memory and starts empty. When the
  // user opens this BP's Coding Agent tab and nothing is attached, resume the
  // most recent session: `dtach -A` re-attaches to the still-running agent
  // (or `claude --resume` restores the conversation if it has exited). With no
  // prior session, start a fresh one so the tab is never empty. Fires once per
  // (copy, bp) visit; only when the tab is actually visible.
  const autoAttachedScope = useRef<string | null>(null);
  useEffect(() => {
    if (!tabVisible || pastLoading) return;
    const key = `${copy}/${bp}`;
    if (agent) {
      autoAttachedScope.current = key; // already attached — nothing to do
      return;
    }
    if (autoAttachedScope.current === key) return;
    autoAttachedScope.current = key;
    const resumable = past
      .filter((s) => s.claudeSessionId && s.kind !== 'sync')
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (resumable?.claudeSessionId) {
      resumeSession(copy, bp, resumable.claudeSessionId, resumable.kind ?? 'claude');
    } else {
      startSession(copy, bp);
    }
    // The scope-keyed guard re-evaluates automatically when (copy, bp) changes
    // — a different key means a different scope to attach. Within one scope it
    // fires once, so a manual exit isn't immediately auto-restarted.
  }, [tabVisible, pastLoading, agent, past, copy, bp, resumeSession, startSession]);

  // A friendly name for the agent chip: the conversation title once the poll
  // has one, else a stable fallback.
  const title = useMemo(() => {
    if (!agent) return null;
    const p = past.find((x) => x.claudeSessionId === agent.id);
    return p?.title || 'Coding agent';
  }, [agent, past]);

  const start = useCallback(async () => {
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // ensureAgent surfaces failure via agentStatus.
      }
    }
    startSession(copy, bp);
  }, [agentStatus, ensureAgent, startSession, copy, bp]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: agent chip + sub-tabs */}
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border bg-background px-5">
        <div className="flex items-center gap-2 border-r border-border pr-4">
          <span
            className={cn(
              'size-1.5 rounded-full',
              agent ? 'bg-emerald-600' : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-[13px] font-semibold text-foreground">
            {title ?? 'No agent running'}
          </span>
        </div>
        <SubTab
          active={sub === 'chat'}
          onClick={() => setSub('chat')}
          icon={<MessageSquare className="size-3.5" aria-hidden />}
          label="Chat"
        />
        <SubTab
          active={sub === 'files'}
          onClick={() => setSub('files')}
          icon={<Folder className="size-3.5" aria-hidden />}
          label="Files"
        />
        <SubTab
          active={sub === 'containers'}
          onClick={() => setSub('containers')}
          icon={<Boxes className="size-3.5" aria-hidden />}
          label="Containers"
        />
        {sub === 'files' && (
          <Button
            variant={showDiff ? 'default' : 'outline'}
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => setShowDiff(!showDiff)}
          >
            <GitPullRequest className="size-3" aria-hidden />
            Diff
          </Button>
        )}
      </div>

      {/* Chat pane — always mounted (hidden when on Files) so the live
          terminal portal target survives the toggle. */}
      <main
        ref={paneRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-zinc-50',
          sub !== 'chat' && 'hidden',
        )}
      >
        {!agent && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            {agentStatus === 'failed' ? (
              <span className="text-destructive">
                Coding agent unavailable — click Start to retry.
              </span>
            ) : (
              <span>No agent running for this business process yet.</span>
            )}
            <Button onClick={start} disabled={agentStatus === 'pending'} size="sm">
              {agentStatus === 'pending' ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Starting coding agent…
                </>
              ) : (
                <>
                  <Plus className="size-3.5" /> Start agent
                </>
              )}
            </Button>
          </div>
        )}
      </main>

      {/* Files pane — mounted alongside so toggling back to Chat doesn't
          remount (and re-fetch) the tree. */}
      <div className={cn('min-h-0 flex-1 overflow-hidden', sub !== 'files' && 'hidden')}>
        {/* Scope the diff to this BP — the whole tab is per-BP, and with
            per-BP repos "the copy's diff" is an aggregate that would mix in
            unrelated business processes. */}
        {showDiff ? (
          <DiffTab copy={copy} pathPrefix={bp} />
        ) : (
          <FilesTab copy={copy} bp={bp} />
        )}
      </div>

      {/* Containers pane — mounted only when active; its LogsPane opens an
          SSE stream we don't want running in the background. */}
      {sub === 'containers' && (
        <ContainersPane bp={bp} copy={copy} active={sub === 'containers'} />
      )}
    </div>
  );
}

function SubTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full items-center gap-1.5 border-b-2 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
