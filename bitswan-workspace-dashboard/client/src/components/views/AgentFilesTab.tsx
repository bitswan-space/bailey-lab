import { useEffect, useRef } from 'react';
import { Boxes, Folder, GitPullRequest, Loader2, MessageSquare } from 'lucide-react';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { ContainersPane } from '@/components/agents/ContainersPane';
import { AgentChooser } from '@/components/agents/AgentChooser';
import { Button } from '@/components/ui/button';
import { useAgentPanelPane } from '@/components/agents/AgentPanels';
import { useAgentChoice } from '@/hooks/useAgentChoice';
import { cn } from '@/lib/utils';
import { useUrlEnum, useUrlFlag } from '@/lib/urlState';

interface AgentFilesTabProps {
  copy: string;
  bp: string;
  branch: string;
  /** True only when the Coding Agent tab is the active tab (the pane stays
   *  mounted-but-hidden otherwise). Gates the panel so we don't spin up an
   *  agent for BPs the user is only browsing on other tabs. */
  tabVisible?: boolean;
}

type Sub = 'chat' | 'files' | 'containers';
const SUBS: Sub[] = ['chat', 'files', 'containers'];

/**
 * The Agents screen, per the wireframe (Workspace Dashboard → Agents): one
 * agent per business process — no session list. A header with Chat / Files /
 * Containers sub-tabs; the right-hand ENVIRONMENT panel lives in WorkspaceView.
 *
 *   - Chat  → the person's coding agent — the Claude Code sidebar hosted by
 *     the dashboard itself (server/src/vscode-host), or the OpenCode web UI
 *     forwarded from their own OpenCode server — rendered in a frame over this
 *     pane. Until they have picked one, the pane asks.
 *   - Files → the copy file browser with a Diff toggle.
 *
 * (Plan, Notes, and the Playwright Browser pane from the wireframe are
 * intentionally not built.)
 */
export function AgentFilesTab({ copy, bp, branch: _branch, tabVisible = true }: AgentFilesTabProps) {
  const choice = useAgentChoice();

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

  // The agent panel for this BP, drawn over the chat pane below. It outlives
  // this component — switching BPs or tabs only hides it — because reloading
  // that iframe is what makes the Claude extension abandon a running agent.
  // Nothing is bound until an agent has been chosen; the chooser sits in the
  // pane instead.
  const chatPaneRef = useAgentPanelPane(copy, bp, tabVisible && sub === 'chat' && choice.state === 'chosen');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: sub-tabs. No session name — one conversation per (user,
          copy, BP), so there is nothing to tell apart. */}
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

      {/* Chat pane — an empty box the agent panel is drawn over. The panel
          itself is mounted by AgentPanelProvider, above every BP switch in
          the app, because reloading that iframe makes the extension treat it
          as a fresh client and kill the running agent. While no agent has
          been chosen the box holds the chooser instead. */}
      <main
        ref={chatPaneRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-zinc-50',
          sub !== 'chat' && 'hidden',
        )}
      >
        {choice.state === 'unchosen' && <AgentChooser />}
        {choice.state === 'loading' && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your settings…
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
