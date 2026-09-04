import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getAccessToken } from '@/lib/auth-token';

interface AgentSidebarProps {
  copy: string;
  bp: string;
}

const FRAME_KEY = '__bitswanSidebar';
const HOST_KEY = '__bitswanHost';

/**
 * The Claude Code VS Code sidebar, hosted by the dashboard's own partial
 * `vscode` API (server/src/vscode-host).
 *
 * The webview is extension-authored HTML running with scripts enabled, so it is
 * confined to a sandboxed frame WITHOUT `allow-same-origin`: it gets an opaque
 * origin and cannot reach the dashboard's DOM, cookies or storage.
 *
 * That opaque origin is also why THIS component owns the websocket rather than
 * the frame: a socket opened inside the frame sends `Origin: null` and no
 * SameSite cookies, so the Bailey gate refuses the upgrade. So the page holds
 * the socket and relays both directions over `postMessage`, which is the same
 * shape VS Code uses — a webview never talks to the extension host directly.
 * `targetOrigin` has to be `*`, because an opaque origin matches nothing else.
 */
export function AgentSidebar({ copy, bp }: AgentSidebarProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    const outbound: string[] = [];

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
      socket.addEventListener('close', () => setReady(false));
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
  }, [copy, bp]);

  const src = `/api/coding-agent/sidebar/view?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}`;
  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        key={src}
        title="Claude Code"
        src={src}
        sandbox="allow-scripts allow-forms allow-popups"
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
