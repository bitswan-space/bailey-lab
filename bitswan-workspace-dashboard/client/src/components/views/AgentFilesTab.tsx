import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Folder,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { ContainersPane } from '@/components/agents/ContainersPane';
import { Button } from '@/components/ui/button';
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { useLatestAgentSession } from '@/hooks/useLatestAgentSession';
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
  /** Bumped when a prompt has been seeded for the agent, to reload its panel. */
  agentReloadNonce?: number;
}

type Sub = 'chat' | 'files' | 'containers';
const SUBS: Sub[] = ['chat', 'files', 'containers'];

/**
 * A session that dies sooner than this never really got going — the agent
 * failed to launch (bad resume, container wedged, claude not authenticated).
 * One that outlives it was a working agent that ended for its own reasons
 * (the user quit it, the server's idle timeout fired, the ws dropped), and is
 * restarted immediately with a clean slate of attempts.
 */
const HEALTHY_SESSION_MS = 20_000;
/**
 * Backoff before each *re*-launch after a failed one. Its length is also the
 * attempt budget: once it's exhausted we stop and show the error rather than
 * hammering the coding-agent container.
 */
const RELAUNCH_BACKOFF_MS = [2_000, 8_000, 20_000];

/**
 * Where autostart stands for the viewed BP. `launching` covers both "a
 * session is up" and "we're about to (re)try one" — the other two are the
 * give-up states the pane renders an error for.
 */
type LaunchState =
  /** Running, starting, or waiting out a backoff before the next attempt. */
  | 'launching'
  /** The agent started and died on launch, every attempt we had. */
  | 'exits-immediately'
  /** The server refused to spawn it — retrying the same request won't help. */
  | 'refused';

/**
 * The Agents screen, per the wireframe (Workspace Dashboard → Agents): one
 * agent per business process — no session list. A header chip shows the
 * agent (status dot + name), then Chat / Files sub-tabs; the right-hand
 * ENVIRONMENT panel lives in WorkspaceView.
 *
 *   - Chat  → the Claude Code sidebar, hosted by the dashboard itself
 *     (server/src/vscode-host) and rendered in a frame over this pane.
 *   - Files → the copy file browser with a Diff toggle.
 *
 * (Plan, Notes, and the Playwright Browser pane from the wireframe are
 * intentionally not built.)
 */
export function AgentFilesTab({
  copy,
  bp,
  branch: _branch,
  tabVisible = true,
  agentReloadNonce = 0,
}: AgentFilesTabProps) {
  const { session: latest, loading: pastLoading } = useLatestAgentSession(copy, bp);

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


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: agent status dot + sub-tabs. No session name — one
          conversation per (user, copy, BP), so there is nothing to tell
          apart; the dot alone carries running / failed / starting. */}
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border bg-background px-5">
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
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-zinc-50',
          sub !== 'chat' && 'hidden',
        )}
      >
        <AgentSidebar copy={copy} bp={bp} reloadNonce={agentReloadNonce} />
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
