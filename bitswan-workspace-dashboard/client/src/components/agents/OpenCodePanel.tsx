import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { subscribeOpenCodeEntry } from '@/lib/agent-handoff';
import {
  OPENCODE_POLL_MS,
  canMountPanel,
  opencodeStateAfterCheck,
  shouldKeepPolling,
  type OpenCodeState,
} from '@/lib/opencodeAvailability';
import { isOpenCodeRoute, sessionPath } from '@/lib/opencodePaths';
import { SessionExpiredError } from '@/lib/session';

interface OpenCodePanelProps {
  copy: string;
  bp: string;
}

/**
 * How many times the panel will pull a wandering frame back per mount. The
 * OpenCode UI's home is `/`, which on this origin is the dashboard; the guard
 * keeps a misbehaving frame from looping instead of stopping at a blank pane.
 */
const MAX_REDIRECTS = 5;

/**
 * The OpenCode chat for one BP: an iframe on this origin showing the OpenCode
 * web UI, which the server forwards to the person's own OpenCode server in the
 * coding-agent container.
 *
 * The page is only mounted once `/status` says the server is up and names the
 * conversation to open (the BP's latest, or one created for it); the page for
 * it is `/server/<key>/session/<id>`, keyed by this origin. After that the
 * frame is never re-pointed by React — its `src` is fixed at mount — and moves
 * only through `location.replace`: when a hand-off from another tab lands in a
 * new conversation, or when the frame has left OpenCode's pages.
 */
export function OpenCodePanel({ copy, bp }: OpenCodePanelProps) {
  // eslint-disable-next-line no-restricted-syntax -- null = React's own ref signature
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<OpenCodeState>({ kind: 'checking' });
  // Bumped by the retry button to re-run the status check from scratch.
  const [attempt, setAttempt] = useState(0);
  // The page the frame was mounted on. Later `ready` answers must not change
  // the iframe's src attribute, which would reload it.
  const mountedEntry = useRef('');
  const redirects = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // 0 is never a live timer id, so it doubles as "nothing scheduled".
    let timer = 0;
    let checks = 0;
    setState({ kind: 'checking' });

    const check = async (): Promise<void> => {
      checks += 1;
      try {
        const r = await api.codingAgent.opencodeStatus(copy, bp);
        if (cancelled) return;
        const next = opencodeStateAfterCheck(r, checks);
        setState(next);
        if (shouldKeepPolling(next)) timer = window.setTimeout(() => void check(), OPENCODE_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        // The app-wide banner owns this one.
        if (err instanceof SessionExpiredError) return;
        setState({ kind: 'error', message: errorMessage(err) });
      }
    };

    void check();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [copy, bp, attempt]);

  /** Point the frame at `entry` without remounting it. */
  const navigate = useCallback((entry: string) => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      frame.contentWindow?.location.replace(entry);
    } catch {
      // A cross-origin document (impossible on this origin, but cheap to
      // survive): fall back to the attribute, which does reload.
      frame.src = entry;
    }
  }, []);

  // A task handed to OpenCode from another tab landed in a new conversation
  // for this BP; show it.
  useEffect(
    () =>
      subscribeOpenCodeEntry((event) => {
        if (event.copy === copy && event.bp === bp) navigate(sessionPath(window.location.origin, event.sessionId));
      }),
    [copy, bp, navigate],
  );

  // The dashboard SPA, loaded inside this frame (OpenCode's home route `/`),
  // refuses to mount and says so; send the frame back to the conversation.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!frameRef.current || ev.source !== frameRef.current.contentWindow) return;
      const data: { type?: string } | undefined = typeof ev.data === 'object' && ev.data ? ev.data : undefined; // eslint-disable-line no-restricted-syntax -- undefined = not a message shape we read; DOM boundary
      if (data?.type !== 'bitswan-nested-dashboard') return;
      if (mountedEntry.current && redirects.current < MAX_REDIRECTS) {
        redirects.current += 1;
        navigate(mountedEntry.current);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);

  // The same check on every load, for pages that are not the dashboard either.
  const onLoad = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !mountedEntry.current) return;
    let pathname: string;
    try {
      pathname = frame.contentWindow?.location.pathname ?? '';
    } catch {
      return;
    }
    if (!pathname || isOpenCodeRoute(pathname)) return;
    if (redirects.current >= MAX_REDIRECTS) return;
    redirects.current += 1;
    navigate(mountedEntry.current);
  }, [navigate]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);

  if (!canMountPanel(state)) {
    return <OpenCodePlaceholder state={state} onRetry={recheck} />;
  }
  if (!mountedEntry.current) mountedEntry.current = sessionPath(window.location.origin, state.sessionId);

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        title="OpenCode"
        src={mountedEntry.current}
        onLoad={onLoad}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

/**
 * What the pane shows when there is no page to show — in place of the panel,
 * never inside it. Each state says which it is: starting, not installed here,
 * or could not start.
 */
function OpenCodePlaceholder({ state, onRetry }: { state: OpenCodeState; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        {(state.kind === 'checking' || state.kind === 'starting') && (
          <>
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {state.kind === 'checking'
                ? 'Starting OpenCode for you…'
                : 'OpenCode is still starting in this workspace’s coding-agent container.'}
            </p>
          </>
        )}
        {state.kind === 'unavailable' && (
          <>
            <p className="text-sm font-medium">OpenCode isn’t available in this workspace</p>
            <p className="break-words text-sm text-muted-foreground">
              {state.reason} A workspace administrator can update the coding-agent image, or you can
              switch back to Claude Code in Settings.
            </p>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <p className="text-sm font-medium">Couldn’t start OpenCode</p>
            <p className="break-words text-sm text-muted-foreground">{state.message}</p>
          </>
        )}
        {(state.kind === 'unavailable' || state.kind === 'error') && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
