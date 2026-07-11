import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Search } from 'lucide-react';
import { toast } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';

// How much history to keep and to ask for. The buffer is what search and copy
// operate on; RENDER_TAIL bounds the DOM so a chatty container doesn't grow
// thousands of nodes (issue #85 — "intelligent support for long logs").
const MAX_LOG_LINES = 10_000;
const RENDER_TAIL = 1_000;
const INITIAL_TAIL = 1_000;

// Batch SSE appends: a container spewing lines would otherwise re-render the
// pane once per line.
const FLUSH_MS = 80;

// Shape of the JSON payload gitops puts on `event: log` (and `event: error`).
// See bitswan-gitops/app/services/automation_service.py:stream_automation_logs.
interface LogEntry {
  line: string;
  stream?: 'stdout' | 'stderr' | string;
}

interface BufferedEntry extends LogEntry {
  // Stable key: buffer indexes shift as the ring buffer trims from the front.
  seq: number;
}

interface ErrorEntry {
  message: string;
  replica?: number;
}

interface LogsPaneProps {
  deploymentId: string | null;
  active: boolean;
}

// Wraps every occurrence of `query` (case-insensitive) in a <mark> so matches
// are visible inside long wrapped lines.
function highlightMatches(line: string, query: string): ReactNode {
  const lower = line.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at === -1) break;
    if (at > i) parts.push(line.slice(i, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-yellow-200 text-inherit">
        {line.slice(at, at + query.length)}
      </mark>,
    );
    i = at + query.length;
  }
  if (parts.length === 0) return line;
  parts.push(line.slice(i));
  return parts;
}

export function LogsPane({ deploymentId, active }: LogsPaneProps) {
  const [lines, setLines] = useState<BufferedEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [query, setQuery] = useState('');
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  // Tracked via a ref so the transport-error handler can read the latest
  // `ended` state without forcing the effect to re-subscribe.
  const endedRef = useRef(false);

  useEffect(() => {
    setLines([]);
    setError(null);
    setEnded(false);
    endedRef.current = false;
    if (!deploymentId || !active) return;

    const es = new EventSource(
      `/api/automations/${encodeURIComponent(deploymentId)}/logs?lines=${INITIAL_TAIL}`,
      { withCredentials: true },
    );

    let seq = 0;
    let pending: BufferedEntry[] = [];
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      setLines((prev) => {
        const merged = prev.concat(batch);
        return merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged;
      });
    };

    const append = (entry: LogEntry) => {
      pending.push({ ...entry, seq: seq++ });
      if (flushTimer === null) flushTimer = window.setTimeout(flush, FLUSH_MS);
    };

    // Gitops emits named SSE events with JSON payloads, not unnamed messages.
    // - event: metadata (replica count + container info) — ignored for now
    // - event: log      ({replica, line, stream})
    // - event: error    ({replica?, message})
    // - event: end      ({})
    es.addEventListener('log', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as LogEntry;
        if (typeof payload.line === 'string') append(payload);
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('error', (ev) => {
      // The 'error' event fires both for upstream-sent errors AND for
      // EventSource's own transport errors. Only the former carries data.
      const data = (ev as MessageEvent).data;
      if (typeof data === 'string' && data.length > 0) {
        try {
          const payload = JSON.parse(data) as ErrorEntry;
          if (payload.message) setError(payload.message);
        } catch {
          // ignore
        }
      }
    });
    es.addEventListener('end', () => {
      endedRef.current = true;
      setEnded(true);
      es.close();
    });
    es.onerror = () => {
      // Transport-level error (network blip). EventSource auto-reconnects;
      // surface as a soft notice rather than tearing down state.
      if (!endedRef.current) setError('Log stream disconnected — reconnecting…');
    };

    return () => {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      es.close();
    };
  }, [deploymentId, active]);

  const trimmedQuery = query.trim();

  // Search covers the whole buffer; the render window only bounds the DOM.
  const matched = useMemo(() => {
    if (!trimmedQuery) return lines;
    const q = trimmedQuery.toLowerCase();
    return lines.filter((entry) => entry.line.toLowerCase().includes(q));
  }, [lines, trimmedQuery]);

  const visible = matched.length > RENDER_TAIL ? matched.slice(matched.length - RENDER_TAIL) : matched;
  const hiddenCount = matched.length - visible.length;

  // Auto-scroll to bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickyRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
  }, []);

  // Copies what search currently selects: the filtered lines when a query is
  // active, otherwise the entire buffer — never just the rendered tail.
  const copyLogs = useCallback(async () => {
    if (matched.length === 0) return;
    const text = matched.map((entry) => entry.line).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(
        trimmedQuery
          ? `Copied ${matched.length} matching line${matched.length === 1 ? '' : 's'}`
          : `Copied ${matched.length} line${matched.length === 1 ? '' : 's'}`,
      );
    } catch {
      toast.error('Copy failed — clipboard unavailable');
    }
  }, [matched, trimmedQuery]);

  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState message="Not deployed for this stage." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs…"
            aria-label="Search logs"
            className="h-7 pl-7 text-xs"
          />
        </div>
        {trimmedQuery && (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {matched.length} of {lines.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          onClick={copyLogs}
          disabled={matched.length === 0}
          title={trimmedQuery ? 'Copy matching lines' : 'Copy all buffered lines'}
        >
          <Copy className="size-3.5" aria-hidden />
          Copy
        </Button>
      </div>
      <ScrollArea
        className="min-h-0 flex-1 bg-zinc-50"
        viewportRef={scrollerRef}
        onViewportScroll={onScroll}
      >
        <div className="px-4 py-3 font-mono text-xs leading-relaxed text-zinc-800">
          {hiddenCount > 0 && (
            <div className="mb-1 text-muted-foreground">
              [showing the last {RENDER_TAIL.toLocaleString()} of {matched.length.toLocaleString()}
              {trimmedQuery ? ' matching' : ''} lines — search and copy cover all of them]
            </div>
          )}
          {lines.length === 0 && !error ? (
            <div className="text-muted-foreground">Waiting for logs…</div>
          ) : visible.length === 0 && trimmedQuery ? (
            <div className="text-muted-foreground">No lines match “{trimmedQuery}”.</div>
          ) : (
            visible.map((entry) => (
              <div
                key={entry.seq}
                className={cn(
                  'whitespace-pre-wrap break-words',
                  entry.stream === 'stderr' && 'text-red-700',
                )}
              >
                {trimmedQuery ? highlightMatches(entry.line, trimmedQuery) : entry.line}
              </div>
            ))
          )}
          {error && <div className="mt-2 text-amber-700">{error}</div>}
          {ended && <div className="mt-2 text-muted-foreground">[stream ended]</div>}
        </div>
      </ScrollArea>
    </div>
  );
}
