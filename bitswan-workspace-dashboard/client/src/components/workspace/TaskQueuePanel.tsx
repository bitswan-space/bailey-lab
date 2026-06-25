import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Clock,
  XCircle,
  Ban,
  Info,
  ListTodo,
  ScrollText,
  Copy,
} from 'lucide-react';
import { toast, useNotifications, type Notification } from '@/lib/notify';
import { useTaskQueue } from './WorkspaceProvider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

// One unified status lane for both git tasks and transient notifications, so a
// single panel can render everything. Notification statuses map onto it:
// loading→running, success→completed, error→failed, info/message→info.
type ActivityStatus = GitTaskStatus | 'info';

/** Active (still in flight) items sort to the top, then newest first. */
function isActive(status: ActivityStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** One row's worth of normalized fields, fed by either source. */
interface ActivityItem {
  key: string;
  status: ActivityStatus;
  /** Bold primary line: a git task's kind, or a notification's message. */
  title: string;
  /** Optional secondary on the title line (git sub-target). */
  label: string | null;
  /** Who initiated it (git tasks carry the requester email). */
  who: string | null;
  /** Detail line: a failure reason / live message / notification description. */
  detail: string | null;
  /** Optional inline action (notifications only). */
  action?: { label: string; onClick: () => void };
  /** When it happened — drives the relative timestamp shown on the row. */
  stampMs: number;
  /** Creation time — the stable chronological ordering key (oldest first). */
  sortMs: number;
  /** Every message this item has shown (oldest→newest). When it has more than
   *  one, the row can be unrolled to reveal the full trail instead of only the
   *  latest. */
  trail?: { text: string; at: number }[];
}

const STATUS_META: Record<
  ActivityStatus,
  { label: string; text: string; Icon: typeof Loader2 }
> = {
  running: { label: 'Running', text: 'text-blue-600 dark:text-blue-400', Icon: Loader2 },
  queued: { label: 'Queued', text: 'text-amber-600 dark:text-amber-400', Icon: Clock },
  completed: { label: 'Done', text: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 },
  failed: { label: 'Failed', text: 'text-destructive', Icon: XCircle },
  cancelled: { label: 'Cancelled', text: 'text-muted-foreground', Icon: Ban },
  info: { label: '', text: 'text-sky-600 dark:text-sky-400', Icon: Info },
};

/** Compact "3m ago" / "just now" relative time from an epoch-ms stamp. */
function relativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return '';
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function gitTaskToItem(task: GitTask): ActivityItem {
  const stamp = task.completed_at ?? task.started_at ?? task.created_at;
  return {
    key: `git:${task.task_id}`,
    status: task.status,
    title: task.kind,
    label: task.label,
    who: task.requester_email,
    detail:
      task.status === 'failed'
        ? task.error
        : task.status === 'running'
          ? task.message
          : null,
    stampMs: Date.parse(stamp),
    sortMs: Date.parse(task.created_at),
  };
}

const NOTIFY_STATUS: Record<Notification['status'], ActivityStatus> = {
  loading: 'running',
  success: 'completed',
  error: 'failed',
  info: 'info',
  message: 'info',
};

function notificationToItem(n: Notification): ActivityItem {
  return {
    key: `notify:${n.id}`,
    status: NOTIFY_STATUS[n.status],
    title: n.message,
    label: null,
    who: null,
    detail: n.description ?? null,
    action: n.action,
    stampMs: n.updated_at,
    sortMs: n.created_at,
    trail: n.trail,
  };
}

function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
  const meta = STATUS_META[item.status];
  const { Icon } = meta;
  const trail = item.trail ?? [];
  // A row is unrollable once it has reported more than one distinct message
  // (a long op whose single notification cycled through progress lines).
  const expandable = trail.length > 1;
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            meta.text,
            item.status === 'running' && 'animate-spin',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {expandable ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                title={expanded ? 'Collapse messages' : `Show all ${trail.length} messages`}
                className="-ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3 transition-transform', !expanded && '-rotate-90')}
                  aria-hidden
                />
              </button>
            ) : null}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {item.title}
            </span>
            {item.label ? (
              <span className="truncate text-muted-foreground">· {item.label}</span>
            ) : null}
          </div>
          {item.who ? (
            <div className="truncate text-muted-foreground">{item.who}</div>
          ) : null}
          {item.detail ? (
            <div
              className={cn(
                'mt-0.5 truncate',
                item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
              )}
              title={item.detail}
            >
              {item.detail}
            </div>
          ) : null}
          {expandable && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              + {trail.length - 1} earlier message{trail.length - 1 === 1 ? '' : 's'}
            </button>
          ) : null}
          {item.action ? (
            <button
              type="button"
              onClick={item.action.onClick}
              className="mt-1 rounded-md border border-input px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
            >
              {item.action.label}
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {meta.label ? <span className={cn('font-medium', meta.text)}>{meta.label}</span> : null}
          <span className="text-muted-foreground">{relativeTime(item.stampMs, now)}</span>
        </div>
      </div>
      {expandable && expanded ? (
        <ol className="ml-5 mt-1 space-y-0.5 border-l border-border pl-2">
          {trail.map((t, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {relativeTime(t.at, now)}
              </span>
              <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-muted-foreground">
                {t.text}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function TaskQueuePanel({
  isAdmin,
}: {
  isAdmin: boolean;
}) {
  const { tasks } = useTaskQueue();
  const notifications = useNotifications();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [clearing, setClearing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  // A ticking clock so relative timestamps stay fresh without per-row timers.
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement>(null);

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

  // Merge both sources into one chronological log: server-side git tasks +
  // client-side notifications, OLDEST first so the most recent is at the bottom
  // (the panel auto-scrolls there). This is a full session history of what was
  // done, not a transient stack.
  const items = useMemo(() => {
    const merged: ActivityItem[] = [
      ...(tasks ?? []).map(gitTaskToItem),
      ...notifications.map(notificationToItem),
    ];
    return merged.sort((a, b) => a.sortMs - b.sortMs);
  }, [tasks, notifications]);

  const activeCount = useMemo(
    () => items.filter((i) => isActive(i.status)).length,
    [items],
  );
  // The admin "Clear queue" acts on the git task queue specifically.
  const gitActive = useMemo(
    () => (tasks ? tasks.filter((t) => t.status === 'queued' || t.status === 'running').length : 0),
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

  const anyRunning = useMemo(
    () => items.some((i) => i.status === 'running'),
    [items],
  );

  // Newest is at the bottom — keep it in view as activity streams in (and when
  // the panel is first expanded). Guarded for the collapsed state (no list).
  const lastKey = items.length ? (items[items.length - 1]?.key ?? '') : '';
  useEffect(() => {
    if (collapsed) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey, collapsed]);

  // Nothing to show — stay out of the way entirely. (`tasks === null` means no
  // snapshot has arrived yet; with no notifications either, render nothing.)
  if (items.length === 0) return null;

  // Collapsed: the panel disappears into a small bottom-right button that never
  // covers page content. A badge shows the in-progress count; the icon spins
  // while something is running so progress is visible without expanding.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        aria-label="Show activity"
        title="Show activity"
        className="pointer-events-auto fixed bottom-4 right-4 z-50 flex size-11 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-lg hover:bg-accent"
      >
        {anyRunning ? (
          <Loader2 className="size-5 animate-spin text-blue-500" />
        ) : (
          <ListTodo className="size-5 text-muted-foreground" />
        )}
        {activeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold leading-4 text-white">
            {activeCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      <div className="pointer-events-auto fixed bottom-4 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        <div className="flex items-center text-xs font-medium text-foreground">
          <button
            type="button"
            onClick={toggle}
            className="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-accent"
            aria-expanded
          >
            <ListTodo className="size-3.5 text-muted-foreground" />
            <span>Activity</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              {activeCount > 0 ? `${activeCount} in progress` : `${items.length} recent`}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setShowLog(true)}
            title="Open the full activity log"
            aria-label="Open the full activity log"
            className="px-2 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ScrollText className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={toggle}
            title="Collapse"
            aria-label="Collapse"
            className="px-2 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        <ul
          ref={listRef}
          className="max-h-72 divide-y divide-border overflow-y-auto border-t border-border"
        >
          {items.map((item) => (
            <ActivityRow key={item.key} item={item} now={now} />
          ))}
        </ul>
        {isAdmin && (
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={onClear}
              disabled={clearing || gitActive === 0}
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
      </div>
      <ActivityLogModal open={showLog} onOpenChange={setShowLog} items={items} now={now} />
    </>
  );
}

/** A copyable, full-text line for one activity item (no truncation). */
function itemToText(item: ActivityItem): string {
  const meta = STATUS_META[item.status];
  const head = [
    `[${(meta.label || item.status).toLowerCase()}]`,
    item.title,
    item.label ? `· ${item.label}` : '',
    item.who ? `(${item.who})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const when = new Date(item.stampMs).toISOString();
  return item.detail ? `${head}\n${item.detail}\n${when}` : `${head}\n${when}`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  } catch {
    toast.error('Copy failed — clipboard unavailable');
  }
}

/**
 * The full activity log: every entry (git tasks + notifications, errors
 * included), oldest→newest, with untruncated text you can select and copy. This
 * is what makes the queue a real log — nothing scrolls out of reach.
 */
function ActivityLogModal({
  open,
  onOpenChange,
  items,
  now,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  items: ActivityItem[];
  now: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="size-4" />
            Activity log
            <span className="text-sm font-normal text-muted-foreground">
              {items.length} entr{items.length === 1 ? 'y' : 'ies'}
            </span>
            <button
              type="button"
              onClick={() => copyText(items.map(itemToText).join('\n\n'))}
              className="ml-auto mr-6 flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
            >
              <Copy className="size-3.5" />
              Copy all
            </button>
          </DialogTitle>
        </DialogHeader>
        <ul className="flex-1 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {items.map((item) => {
            const meta = STATUS_META[item.status];
            const { Icon } = meta;
            return (
              <li key={item.key} className="group flex items-start gap-2 px-3 py-2 text-xs">
                <Icon
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    meta.text,
                    item.status === 'running' && 'animate-spin',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{item.title}</span>
                    {item.label ? (
                      <span className="text-muted-foreground">· {item.label}</span>
                    ) : null}
                    {meta.label ? (
                      <span className={cn('font-medium', meta.text)}>· {meta.label}</span>
                    ) : null}
                    <span className="text-muted-foreground">· {relativeTime(item.stampMs, now)}</span>
                  </div>
                  {item.who ? (
                    <div className="text-muted-foreground">{item.who}</div>
                  ) : null}
                  {item.detail ? (
                    <pre
                      className={cn(
                        'mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px]',
                        item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {item.detail}
                    </pre>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => copyText(itemToText(item))}
                  title="Copy this entry"
                  aria-label="Copy this entry"
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                >
                  <Copy className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
