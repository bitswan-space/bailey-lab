import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/shared/EmptyState';

const MAX_LOG_LINES = 2000;

// Shape of the JSON payload the dashboard server puts on `event: log` when
// re-framing the gitops `docker build` text stream. See the
// `/api/images/builds/:checksum/logs` route in server/src/routes/automations.ts.
interface LogEntry {
  line: string;
}

interface BuildLogsPaneProps {
  /** Image build checksum, or null when this container has no built image. */
  checksum: string | null;
  active: boolean;
}

/**
 * Streams an image's `docker build` log by checksum. Mirrors LogsPane's
 * EventSource machinery; the server re-frames gitops's plain-text build output
 * as `event: log` lines, then `event: end` once a completed build's final log
 * is fully read (an in-progress build keeps following live).
 */
export function BuildLogsPane({ checksum, active }: BuildLogsPaneProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  // No captured build output after the grace window — the image was almost
  // always served from cache (no `docker build` ran), so gitops has no log to
  // follow. Surface that honestly instead of spinning "Waiting…" forever.
  const [stalled, setStalled] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  const endedRef = useRef(false);
  const gotDataRef = useRef(false);

  useEffect(() => {
    setLines([]);
    setError(null);
    setEnded(false);
    setStalled(false);
    endedRef.current = false;
    gotDataRef.current = false;
    if (!checksum || !active) return;

    const es = new EventSource(
      `/api/images/builds/${encodeURIComponent(checksum)}/logs`,
      { withCredentials: true },
    );

    // If nothing streams in within the grace window and the build hasn't
    // ended/errored, treat it as "no captured log" (cache hit). A real build
    // emits "Build started…" within a second or two, so this won't fire mid-build.
    const graceTimer = setTimeout(() => {
      if (!gotDataRef.current && !endedRef.current) setStalled(true);
    }, 7000);

    const append = (line: string) => {
      gotDataRef.current = true;
      setStalled(false);
      setLines((prev) => {
        const next =
          prev.length >= MAX_LOG_LINES
            ? prev.slice(prev.length - MAX_LOG_LINES + 1)
            : prev.slice();
        next.push(line);
        return next;
      });
    };

    es.addEventListener('log', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as LogEntry;
        // Strip ANSI color/CSI escapes — `docker build` colourises stderr, which
        // would otherwise render as literal `[91m…[0m` noise in the viewer.
        // eslint-disable-next-line no-control-regex -- matching the ESC control char is the point
        if (typeof payload.line === 'string') append(payload.line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''));
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('error', (ev) => {
      // Upstream-sent errors carry data; EventSource's own transport errors
      // (handled in onerror) do not.
      const data = (ev as MessageEvent).data;
      if (typeof data === 'string' && data.length > 0) {
        try {
          setError(JSON.parse(data) as string);
        } catch {
          setError(data);
        }
      }
    });
    es.addEventListener('end', () => {
      endedRef.current = true;
      setEnded(true);
      es.close();
    });
    es.onerror = () => {
      if (!endedRef.current) setError('Build-log stream disconnected — reconnecting…');
    };

    return () => {
      clearTimeout(graceTimer);
      es.close();
    };
  }, [checksum, active]);

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

  if (!checksum) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState message="No built image for this container yet — deploy it to see build logs." />
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
          stalled ? (
            <div className="text-muted-foreground">
              No build log available for this image.
            </div>
          ) : (
            <div className="text-muted-foreground">Waiting for build logs…</div>
          )
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))
        )}
        {error && <div className="mt-2 text-amber-700">{error}</div>}
        {ended && <div className="mt-2 text-muted-foreground">[build log ended]</div>}
      </div>
    </ScrollArea>
  );
}
