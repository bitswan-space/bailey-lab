import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getAccessToken } from '@/lib/auth-token';
import { api, errorMessage } from '@/lib/api';
import { SessionExpiredError } from '@/lib/session';
import {
  SIDEBAR_POLL_MS,
  canMountPanel,
  shouldKeepPolling,
  sidebarStateAfterCheck,
  type SidebarState,
} from '@/lib/sidebarAvailability';

interface AgentSidebarProps {
  copy: string;
  bp: string;
}

const FRAME_KEY = '__bitswanSidebar';
const HOST_KEY = '__bitswanHost';

export function AgentSidebar({ copy, bp }: AgentSidebarProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<SidebarState>({ kind: 'checking' });
  // Bumped by the retry button to re-run the availability check from scratch.
  const [attempt, setAttempt] = useState(0);

  /**
   * Ask whether there is a panel before pointing an iframe at one.
   *
   * `/view` refuses with a JSON 503 when the extension is not on disk, and an
   * iframe renders a refusal by displaying its body — which is how this tab
   * came to show a bare `{"error":"sidebar not available"}`. The status route
   * has always answered this honestly; it just had no caller.
   */
  useEffect(() => {
    let cancelled = false;
    // 0 is never a live timer id, so it doubles as "nothing scheduled" and
    // keeps clearTimeout unconditional.
    let timer = 0;
    let checks = 0;
    setState({ kind: 'checking' });

    const check = async (): Promise<void> => {
      checks += 1;
      try {
        const { available } = await api.codingAgent.sidebarStatus();
        if (cancelled) return;
        const next = sidebarStateAfterCheck(available, checks);
        setState(next);
        // The extension is downloaded by the container's entrypoint after the
        // server is already answering, so "not yet" is an ordinary state on a
        // healthy workspace — wait it out rather than declaring failure.
        if (shouldKeepPolling(next)) timer = window.setTimeout(() => void check(), SIDEBAR_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        // The app-wide banner owns this one; a second message here would be
        // noise on top of a re-login prompt.
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

  const mounted = canMountPanel(state);

  useEffect(() => {
    // No panel, no host connection to make — the socket exists to relay the
    // iframe's messages, and there is no iframe until the extension is there.
    if (!mounted) return;

    let socket: WebSocket | undefined;
    let closed = false;
    const outbound: string[] = [];
    setReady(false);
    setFailed(false);

    const fromFrame = (ev: MessageEvent) => {
      const data = ev.data as { [FRAME_KEY]?: boolean; payload?: unknown } | null;
      if (!data || data[FRAME_KEY] !== true) return;
      const payload = JSON.stringify(data.payload);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
      else outbound.push(payload);
    };
    window.addEventListener('message', fromFrame);

    void (async () => {
      const token = await getAccessToken().catch(() => null);
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({ copy, bp });
      if (token) qs.set('access_token', token);
      socket = new WebSocket(`${proto}//${window.location.host}/ws/coding-agent-sidebar?${qs}`);
      socket.addEventListener('open', () => {
        setReady(true);
        outbound.splice(0).forEach((m) => socket?.send(m));
      });
      socket.addEventListener('error', () => setFailed(true));
      socket.addEventListener('close', () => {
        setReady(false);
        setFailed(true);
      });
      socket.addEventListener('message', (ev) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        frameRef.current?.contentWindow?.postMessage({ [HOST_KEY]: true, payload }, '*');
      });
    })();

    return () => {
      closed = true;
      window.removeEventListener('message', fromFrame);
      socket?.close();
    };
  }, [copy, bp, mounted]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);

  if (!mounted) {
    return <SidebarPlaceholder state={state} onRetry={recheck} />;
  }

  const src = `/api/coding-agent/sidebar/view?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}`;
  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        key={src}
        title="Claude Code"
        src={src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        className="h-full w-full border-0 bg-white"
      />
      {!ready && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-white/85 py-2 text-xs text-muted-foreground">
          {failed ? (
            <>Lost the connection to the agent — reload to retry.</>
          ) : (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Connecting to the agent…
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the tab shows when there is no panel to show — in place of the panel,
 * never inside it. Each state says which of the three it is, because "still
 * arriving", "it is not coming" and "we could not ask" want different things
 * from the reader.
 */
function SidebarPlaceholder({ state, onRetry }: { state: SidebarState; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        {(state.kind === 'checking' || state.kind === 'preparing') && (
          <>
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {state.kind === 'checking'
                ? 'Looking for the coding agent…'
                : 'Setting up the coding agent — its editor extension is still downloading. This runs once per workspace.'}
            </p>
          </>
        )}
        {state.kind === 'unavailable' && (
          <>
            <p className="text-sm font-medium">The coding agent isn’t available here</p>
            <p className="text-sm text-muted-foreground">
              Its editor extension never finished downloading into this workspace. A workspace
              administrator can check the dashboard container’s logs for the download.
            </p>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <p className="text-sm font-medium">Couldn’t check whether the coding agent is ready</p>
            <p className="break-words text-sm text-muted-foreground">{state.message}</p>
          </>
        )}
        {(state.kind === 'unavailable' || state.kind === 'error') && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Check again
          </button>
        )}
      </div>
    </div>
  );
}
