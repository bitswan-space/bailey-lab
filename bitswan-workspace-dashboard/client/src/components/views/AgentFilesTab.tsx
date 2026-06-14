import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, GitPullRequest, Loader2, MessageSquare, Plus } from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { Button } from '@/components/ui/button';
import { useSessions } from '@/components/agents/SessionProvider';
import { useAgentSessions } from '@/hooks/useAgentSessions';
import { cn } from '@/lib/utils';

interface AgentFilesTabProps {
  worktree: string;
  bp: string;
  branch: string;
}

type Sub = 'chat' | 'files';

/**
 * The Agents screen, per the wireframe (Workspace Dashboard → Agents): one
 * agent per business process — no session list. A header chip shows the
 * agent (status dot + name), then Chat / Files sub-tabs; the right-hand
 * ENVIRONMENT panel lives in WorkspaceView.
 *
 *   - Chat  → the live coding-agent terminal. It renders in SessionProvider's
 *     portal layer over this pane, so it must stay mounted (we hide it, not
 *     unmount it, when Files is active) or the running terminal is torn down.
 *   - Files → the worktree file browser with a Diff toggle.
 *
 * (Plan, Notes, and the Playwright Browser pane from the wireframe are
 * intentionally not built.)
 */
export function AgentFilesTab({ worktree, bp, branch: _branch }: AgentFilesTabProps) {
  const {
    sessions: allSessions,
    startSession,
    setCurrentScope,
    setPaneEl,
    selectedFor,
    setSelectedFor,
    agentStatus,
    ensureAgent,
  } = useSessions();
  const { sessions: past } = useAgentSessions(worktree, bp);

  const [sub, setSub] = useState<Sub>('chat');
  const [showDiff, setShowDiff] = useState(false);
  useEffect(() => {
    setShowDiff(false);
  }, [sub, worktree]);

  // Bind this BP as the active scope and hand the provider the Chat pane so
  // it can portal the terminal over it. Cleanup unbinds so terminals stay
  // alive (just hidden) when the user navigates away.
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setCurrentScope({ worktree, bp });
    return () => setCurrentScope(null);
  }, [worktree, bp, setCurrentScope]);
  useEffect(() => {
    setPaneEl(paneRef.current);
    return () => setPaneEl(null);
  }, [setPaneEl]);

  // The BP's live sessions. One agent per BP: the selected active session, or
  // the first running one. Sync sessions are worktree-level and bp-less.
  const active = useMemo(
    () =>
      allSessions.filter(
        (s) => !s.exited && s.worktree === worktree && (s.kind === 'sync' || s.bp === bp),
      ),
    [allSessions, worktree, bp],
  );
  const selectedId = selectedFor({ worktree, bp });
  const agent = active.find((s) => s.id === selectedId) ?? active[0];

  // Keep the scope selection pointed at the live agent so the provider shows
  // the right terminal.
  useEffect(() => {
    if (agent && agent.id !== selectedId) {
      setSelectedFor({ worktree, bp }, agent.id);
    }
  }, [agent, selectedId, setSelectedFor, worktree, bp]);

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
    startSession(worktree, bp);
  }, [agentStatus, ensureAgent, startSession, worktree, bp]);

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
        {sub === 'files' && (
          <Button
            variant={showDiff ? 'default' : 'outline'}
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => setShowDiff((v) => !v)}
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
        {showDiff ? <DiffTab worktree={worktree} /> : <FilesTab worktree={worktree} bp={bp} />}
      </div>
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
