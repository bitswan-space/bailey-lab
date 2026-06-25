import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Clock,
  XCircle,
  Ban,
  ListTodo,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTaskQueue } from './WorkspaceProvider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { GitTask, GitTaskStatus } from '@/types';

const COLLAPSE_KEY = 'dashboard.taskQueue.collapsed';

// eslint-disable-next-line no-restricted-syntax -- localStorage parse boundary
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Active (still in flight) tasks sort to the top, then newest first. */
function isActive(status: GitTaskStatus): boolean {
  return status === 'queued' || status === 'running';
}

const STATUS_META: Record<
  GitTaskStatus,
  { label: string; dot: string; text: string; Icon: typeof Loader2 }
> = {
  running: {
    label: 'Running',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
    Icon: Loader2,
  },
  queued: {
    label: 'Queued',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    Icon: Clock,
  },
  completed: {
    label: 'Done',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    Icon: CheckCircle2,
  },
  failed: {
    label: 'Failed',
    dot: 'bg-destructive',
    text: 'text-destructive',
    Icon: XCircle,
  },
  cancelled: {
    label: 'Cancelled',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    Icon: Ban,
  },
};

/** Compact "3m ago" / "just now" relative time. */
function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function TaskRow({ task, now }: { task: GitTask; now: number }) {
  const meta = STATUS_META[task.status];
  const { Icon } = meta;
  // The most relevant timestamp for "when": completion if terminal, else start
  // (running) or creation (queued).
  const stamp = task.completed_at ?? task.started_at ?? task.created_at;
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-xs">
      <Icon
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          meta.text,
          task.status === 'running' && 'animate-spin',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground">{task.kind}</span>
          {task.label ? (
            <span className="truncate text-muted-foreground">· {task.label}</span>
          ) : null}
        </div>
        <div className="truncate text-muted-foreground">
          {task.requester_email}
        </div>
        {task.status === 'failed' && task.error ? (
          <div className="mt-0.5 truncate text-destructive" title={task.error}>
            {task.error}
          </div>
        ) : task.status === 'running' && task.message ? (
          <div className="mt-0.5 truncate text-muted-foreground" title={task.message}>
            {task.message}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span className={cn('font-medium', meta.text)}>{meta.label}</span>
        <span className="text-muted-foreground">{relativeTime(stamp, now)}</span>
      </div>
    </li>
  );
}

export function TaskQueuePanel({
  isAdmin,
}: {
  isAdmin: boolean;
}) {
  const { tasks } = useTaskQueue();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [clearing, setClearing] = useState(false);
  // A ticking clock so relative timestamps stay fresh without per-row timers.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // ignore quota / unavailable
      }
      return next;
    });
  }, []);

  // Sort: active (running/queued) first, then newest-first by created_at.
  const sorted = useMemo(() => {
    if (!tasks) return tasks;
    return tasks.slice().sort((a, b) => {
      const aa = isActive(a.status) ? 0 : 1;
      const bb = isActive(b.status) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return Date.parse(b.created_at) - Date.parse(a.created_at);
    });
  }, [tasks]);

  const activeCount = useMemo(
    () => (tasks ? tasks.filter((t) => isActive(t.status)).length : 0),
    [tasks],
  );

  const onClear = useCallback(async () => {
    setClearing(true);
    try {
      const res = await api.clearTasks();
      toast.success(
        res.cancelled > 0
          ? `Cancelled ${res.cancelled} task${res.cancelled === 1 ? '' : 's'}`
          : 'Queue already idle',
      );
    } catch (err) {
      toast.error(`Could not clear the queue: ${String(err)}`);
    } finally {
      setClearing(false);
    }
  }, []);

  // Nothing delivered yet (or gitops not configured) — render nothing rather
  // than a fabricated idle state. The empty-but-loaded case below shows once a
  // snapshot has actually arrived.
  if (sorted === null) return null;
  // Truly empty queue: stay out of the way entirely.
  if (sorted.length === 0) return null;

  return (
    <div className="pointer-events-auto fixed bottom-4 left-4 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background shadow-lg">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-accent"
        aria-expanded={!collapsed}
      >
        <ListTodo className="size-3.5 text-muted-foreground" />
        <span>Queue</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {activeCount > 0
            ? `${activeCount} running/queued`
            : `${sorted.length} recent`}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-4 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
        />
      </button>
      {!collapsed && (
        <>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto border-t border-border">
            {sorted.map((task) => (
              <TaskRow key={task.task_id} task={task} now={now} />
            ))}
          </ul>
          {isAdmin && (
            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={onClear}
                disabled={clearing || activeCount === 0}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-input px-2 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                {clearing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Ban className="size-3.5" />
                )}
                Clear queue
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
