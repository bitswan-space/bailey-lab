import { useEffect, useState } from 'react';
import { Bot, FolderTree, GitPullRequest } from 'lucide-react';
import { AgentsTab } from '@/components/agents/AgentsTab';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AgentFilesTabProps {
  worktree: string;
  bp: string;
  branch: string;
}

type Inner = 'agent' | 'files';

/**
 * The Coding Agent tab: the agent session view plus an inner "Files" area
 * (per the design's agent tool tabs) hosting the file browser with a Diff
 * toggle. Both panes stay mounted (`hidden`-toggled) so agent terminals and
 * their pane binding survive the inner toggle.
 */
export function AgentFilesTab({ worktree, bp, branch }: AgentFilesTabProps) {
  const [inner, setInner] = useState<Inner>('agent');
  const [showDiff, setShowDiff] = useState(false);

  // Reset the Diff toggle when leaving Files or changing worktree, matching
  // the design prototype's behaviour.
  useEffect(() => {
    setShowDiff(false);
  }, [inner, worktree]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-border bg-muted/40 px-5">
        <InnerTab
          active={inner === 'agent'}
          onClick={() => setInner('agent')}
          icon={<Bot className="size-3.5" aria-hidden />}
          label="Agent"
        />
        <InnerTab
          active={inner === 'files'}
          onClick={() => setInner('files')}
          icon={<FolderTree className="size-3.5" aria-hidden />}
          label="Files"
        />
        {inner === 'files' && (
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

      {/* Both panes stay mounted; visibility via `hidden` so the agent
          terminal (and its SessionProvider pane binding) survives. */}
      <div className={cn('min-h-0 flex-1', inner !== 'agent' && 'hidden')}>
        <AgentsTab worktree={worktree} bp={bp} branch={branch} />
      </div>
      <div
        className={cn(
          'min-h-0 flex-1 overflow-hidden',
          inner !== 'files' && 'hidden',
        )}
      >
        {showDiff ? (
          <DiffTab worktree={worktree} />
        ) : (
          <FilesTab worktree={worktree} bp={bp} />
        )}
      </div>
    </div>
  );
}

function InnerTab({
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
