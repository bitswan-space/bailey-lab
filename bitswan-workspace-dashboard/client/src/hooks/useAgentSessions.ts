import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeader, clearAccessToken } from '@/lib/auth-token';

export interface AgentSession {
  id: string;
  timestamp: string;
  userEmail: string;
  copy: string;
  bp: string | null;
  castFile: string;
  logged: boolean;
  /** Claude conversation UUID; null for legacy / editor-created sessions. */
  claudeSessionId: string | null;
  /** "claude" / "sync" / "requirement" / "write-tests" / "automation" / null. Drives the row icon. */
  kind: 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation' | null;
  /** First user prompt from the JSONL, truncated. Empty until user typed. */
  title: string;
}

interface Result {
  sessions: AgentSession[];
  loading: boolean;
  refresh: () => void;
}

const POLL_MS = 5000;

/**
 * Poll `/api/coding-agent/sessions?copy=…&bp=…` every 5s, and on window
 * focus. Returns the merged list and a `refresh()` for forced fetches —
 * SessionTerminal uses that when its WebSocket closes so the just-ended
 * session shows up immediately without waiting for the next tick.
 */
export function useAgentSessions(copy: string, bp: string): Result {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const fetchNow = useCallback(async () => {
    try {
      const url = `/api/coding-agent/sessions?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}`;
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: await authHeader(),
      });
      // Token may have expired — drop the cache so the next poll re-fetches it.
      if (r.status === 401) clearAccessToken();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as AgentSession[];
      if (aliveRef.current) setSessions(data);
    } catch {
      // Swallow polling errors; the next tick will retry.
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [copy, bp]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    fetchNow();
    const id = setInterval(fetchNow, POLL_MS);
    const onFocus = () => fetchNow();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchNow]);

  return { sessions, loading, refresh: fetchNow };
}
