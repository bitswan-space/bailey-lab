import { useCallback, useEffect, useMemo, useState } from 'react';
import { Terminal } from '@/components/terminal/Terminal';
import { api } from '@/lib/api';
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

  // Pasted/dropped images land in `.agent-uploads/` under the session's cwd
  // — the BP dir for claude/requirement sessions, the copy root for sync
  // (mirrors the cd logic in server/src/routes/coding-agent.ts) — so the
  // path we hand back resolves relative to where Claude is running. Files
  // are timestamp-renamed because every clipboard paste arrives as
  // "image.png" and the upload endpoint overwrites on name collision.
  const onUploadImages = useCallback(
    async (files: File[]) => {
      const dir = bp ? `${bp}/.agent-uploads` : '.agent-uploads';
      const stamped = files.map((f, i) => {
        const ext = /\.[A-Za-z0-9]+$/.exec(f.name)?.[0] ?? '.png';
        return new File([f], `paste-${Date.now()}-${i}${ext}`, { type: f.type });
      });
      // Ship a self-ignoring .gitignore with every batch so pasted images
      // never show up in the copy's git status or ride along with a
      // Sync & Deploy. Re-sent each time (2 bytes) rather than tracked,
      // since the cleanup sweeper may remove the whole directory.
      const gitignore = new File(['*\n'], '.gitignore', { type: 'text/plain' });
      const r = await api.copyFiles.upload(copy, dir, [gitignore, ...stamped]);
      return r.written
        .filter((w) => w.name !== '.gitignore')
        .map((w) => `.agent-uploads/${w.name}`);
    },
    [copy, bp],
  );

  return (
    <div className="h-full w-full" style={{ display: hidden ? 'none' : 'block' }}>
      {wsUrl ? (
        <Terminal wsUrl={wsUrl} onExit={onExit} onUploadImages={onUploadImages} />
      ) : (
        <div className="grid h-full place-items-center text-sm text-muted-foreground">
          Connecting…
        </div>
      )}
    </div>
  );
}
