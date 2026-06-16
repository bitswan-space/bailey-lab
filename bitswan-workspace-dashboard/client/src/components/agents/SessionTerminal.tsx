import { useEffect, useMemo, useState } from 'react';
import { Terminal } from '@/components/terminal/Terminal';
import { getAccessToken } from '@/lib/auth-token';

interface Props {
  copy: string;
  /** Null for copy-level sync sessions; the WS route handles missing bp. */
  bp: string | null;
  kind: 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation';
  /** Requirement id when kind === 'requirement'. The server reads the description from the TOML. */
  requirementId?: string;
  /** Claude session UUID. We control it client-side so we can `--resume` it later. */
  sessionId: string;
  /** When true, ssh into the agent with `claude --resume <sessionId>` instead of a fresh session. */
  resume: boolean;
  hidden: boolean;
  onExit: () => void;
}

/**
 * Backed-by-xterm terminal for a single agent session. Kept mounted even
 * when `hidden` (CSS-toggled `display`) so backgrounded sessions stay
 * connected — the WebSocket and the upstream ssh process keep running.
 */
export function SessionTerminal({
  copy,
  bp,
  kind,
  requirementId,
  sessionId,
  resume,
  hidden,
  onExit,
}: Props) {
  // The Bailey gate strips identity headers and WebSockets can't send an
  // Authorization header, so we pass the Keycloak access token as a query
  // param (the server validates it). Resolve it before opening the socket.
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAccessToken().then((t) => {
      if (!cancelled) setToken(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable URL — the underlying WebSocket reconnects whenever this changes,
  // so we keep it derived from the immutable session inputs. Null until the
  // access token is resolved.
  const wsUrl = useMemo(() => {
    if (!token) return null;
    const params = new URLSearchParams({
      copy,
      kind,
      ...(bp ? { bp } : {}),
      ...(requirementId ? { requirement_id: requirementId } : {}),
      ...(resume ? { resume: sessionId } : { session_id: sessionId }),
      access_token: token,
    });
    return `/ws/coding-agent?${params.toString()}`;
  }, [copy, bp, kind, requirementId, sessionId, resume, token]);

  return (
    <div className="h-full w-full" style={{ display: hidden ? 'none' : 'block' }}>
      {wsUrl ? (
        <Terminal wsUrl={wsUrl} onExit={onExit} />
      ) : (
        <div className="grid h-full place-items-center text-sm text-muted-foreground">
          Connecting…
        </div>
      )}
    </div>
  );
}
