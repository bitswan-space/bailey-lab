import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';

const MAX_LOG_LINES = 500;

// Shape of the JSON payload gitops puts on `event: log` (and `event: error`).
// See bitswan-gitops/app/services/automation_service.py:stream_automation_logs.
interface LogEntry {
  line: string;
  stream?: 'stdout' | 'stderr' | string;
}

interface ErrorEntry {
  message: string;
  replica?: number;
}

interface LogsPaneProps {
  deploymentId: string | null;
  active: boolean;
}

export function LogsPane({ deploymentId, active }: LogsPaneProps) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    setLines([]);
    setError(null);
    setEnded(false);
    if (!deploymentId || !active) return;

    const es = new EventSource(
      `/api/automations/${encodeURIComponent(deploymentId)}/logs`,
      { withCredentials: true },
    );

    const append = (entry: LogEntry) => {
      setLines((prev) => {
        const next =
          prev.length >= MAX_LOG_LINES ? prev.slice(prev.length - MAX_LOG_LINES + 1) : prev.slice();
        next.push(entry);
        return next;
      });
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
      setEnded(true);
      es.close();
    });
    es.onerror = () => {
      // Transport-level error (network blip). EventSource auto-reconnects;
      // surface as a soft notice rather than tearing down state.
      if (!ended) setError('Log stream disconnected — reconnecting…');
    };

    return () => es.close();
  }, [deploymentId, active, ended]);

  // Auto-scroll to bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickyRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
  }, []);

  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState message="Not deployed for this stage." />
      </div>
    );
  }

  return (
    <ScrollArea
      className="h-full bg-zinc-50"
      viewportRef={scrollerRef}
      onViewportScroll={onScroll}
    >
      <div className="px-4 py-3 font-mono text-xs leading-relaxed text-zinc-800">
        {lines.length === 0 && !error ? (
          <div className="text-muted-foreground">Waiting for logs…</div>
        ) : (
          lines.map((entry, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-words',
                entry.stream === 'stderr' && 'text-red-700',
              )}
            >
              {entry.line}
            </div>
          ))
        )}
        {error && <div className="mt-2 text-amber-700">{error}</div>}
        {ended && <div className="mt-2 text-muted-foreground">[stream ended]</div>}
      </div>
    </ScrollArea>
  );
}
