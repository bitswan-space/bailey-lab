import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getAccessToken } from '@/lib/auth-token';
import { onAgentHandoff } from '@/lib/agent-handoff';

interface AgentSidebarProps {
  copy: string;
  bp: string;
}

const FRAME_KEY = '__bitswanSidebar';
const HOST_KEY = '__bitswanHost';

export function AgentSidebar({ copy, bp }: AgentSidebarProps) {
  // A prompt handed to this copy's agent is seeded for the panel's next load,
  // so the panel has to load again for the person to see it.
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(
    () => onAgentHandoff((h) => {
      if (h.copy === copy && h.bp === bp) setReloadNonce((n) => n + 1);
    }),
    [copy, bp],
  );
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
  }, [copy, bp]);

  const src = `/api/coding-agent/sidebar/view?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}${reloadNonce ? `&n=${reloadNonce}` : ''}`;
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
