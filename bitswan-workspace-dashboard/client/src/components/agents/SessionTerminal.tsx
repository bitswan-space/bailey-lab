import { useMemo } from 'react';
import { Terminal } from '@/components/terminal/Terminal';

interface Props {
  worktree: string;
  /** Null for worktree-level sync sessions; the WS route handles missing bp. */
  bp: string | null;
  kind: 'claude' | 'sync';
  /** Claude session UUID. We control it client-side so we can `--resume` it later. */
  sessionId: string;
  /** When true, ssh into the agent with `claude --resume <sessionId>` instead of a fresh session. */
  resume: boolean;
  hidden: boolean;
  onExit: () => void;
}

/**
 * Backed-by-xterm terminal for a single agent session. Kept mounted even
 * when `hidden` (CSS-toggled `display`) so backgrounded sessions stay
 * connected — the WebSocket and the upstream ssh process keep running.
 */
export function SessionTerminal({
  worktree,
  bp,
  kind,
  sessionId,
  resume,
  hidden,
  onExit,
}: Props) {
  // Stable URL — the underlying WebSocket reconnects whenever this changes,
  // so we keep it derived from the immutable session inputs.
  const wsUrl = useMemo(() => {
    const params = new URLSearchParams({
      worktree,
      kind,
      ...(bp ? { bp } : {}),
      ...(resume ? { resume: sessionId } : { session_id: sessionId }),
    });
    return `/ws/coding-agent?${params.toString()}`;
  }, [worktree, bp, kind, sessionId, resume]);

  return (
    <div className="h-full w-full" style={{ display: hidden ? 'none' : 'block' }}>
      <Terminal wsUrl={wsUrl} onExit={onExit} />
    </div>
  );
}
