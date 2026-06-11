import type { KeyboardEvent } from 'react';
import { Bot, ClipboardCheck, Play, RefreshCw, RotateCcw } from 'lucide-react';

export interface SessionRowData {
  /** Unique id within the AgentsTab session list. */
  id: string;
  name: string;
  branch: string;
  lastActive: string;
  status: 'running' | 'idle';
  /** Which kind of session — drives the leading icon. */
  kind: 'claude' | 'sync' | 'requirement';
  /** Present on past sessions only — used to fire playback. */
  castFile?: string;
  /** Present when this past row has a known Claude session UUID — enables Resume. */
  claudeSessionId?: string;
}

interface Props {
  s: SessionRowData;
  active: boolean;
  onClick: () => void;
  onPlay?: () => void;
  onResume?: (claudeSessionId: string) => void;
}

/**
 * Sidebar entry for an active or past agent session. Mirrors the row in the
 * design reference at workspace-dashboard/project/src/worktree.jsx:227-262
 * but in Tailwind so it stays in line with the rest of the dashboard.
 */
export function AgentSessionRow({ s, active, onClick, onPlay, onResume }: Props) {
  const dotClass =
    s.status === 'running' ? 'bg-emerald-500' : 'bg-zinc-400';
  const labelClass =
    s.status === 'running' ? 'text-emerald-600' : 'text-muted-foreground';
  const pulse = s.status === 'running' ? 'animate-pulse' : '';

  // Outer is a div-with-role="button" rather than a real <button> so we can
  // nest the Play <button> inside without invalid DOM nesting. Keyboard
  // semantics (Enter / Space → click) are restored explicitly below.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`group flex w-full cursor-pointer items-center gap-3 border-b border-border px-3.5 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 ${
        active
          ? 'border-l-[3px] border-l-foreground bg-muted/60'
          : 'border-l-[3px] border-l-transparent bg-white hover:bg-muted/30'
      }`}
    >
      <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        {s.kind === 'sync' ? (
          <RefreshCw className="size-3.5 text-muted-foreground" aria-hidden />
        ) : s.kind === 'requirement' ? (
          <ClipboardCheck className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <Bot className="size-3.5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{s.name}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {s.branch} · {s.lastActive}
        </div>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide ${labelClass}`}
      >
        <span className={`size-1.5 rounded-full ${dotClass} ${pulse}`} aria-hidden />
        {s.status}
      </span>
      {onResume && s.claudeSessionId ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResume(s.claudeSessionId!);
          }}
          className="ml-2 inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label="Resume session"
          title="Resume this session"
        >
          <RotateCcw className="size-3.5" />
        </button>
      ) : null}
      {onPlay && s.castFile ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPlay();
          }}
          className="ml-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label="Play recording"
        >
          <Play className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
