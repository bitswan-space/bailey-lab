import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeader, clearAccessToken } from '@/lib/auth-token';
import { useSessions } from '@/components/agents/SessionProvider';

export interface LatestAgentSession {
  timestamp: string;
  userEmail: string;
  copy: string;
  bp: string | null;
  /** Claude conversation UUID — what the Agents tab resumes. */
  claudeSessionId: string;
  /** Conversation title (ai-title / rename / first prompt). Empty until one exists. */
  title: string;
}

interface Result {
  /** The scope's resume candidate, or null when it has never run a session. */
  // eslint-disable-next-line no-restricted-syntax -- null = no session yet
  session: LatestAgentSession | null;
  loading: boolean;
}

/**
 * The scope's most-recent Claude conversation, from
 * `/api/coding-agent/session/latest`. One conversation per (user, copy, BP),
 * so there is nothing to poll: fetched once per scope, then re-fetched only
 * when a session in this scope ends (its meta/title may have changed) —
 * driven by the SessionProvider's exit events.
 */
export function useLatestAgentSession(copy: string, bp: string): Result {
  // eslint-disable-next-line no-restricted-syntax -- null = no session yet
  const [session, setSession] = useState<LatestAgentSession | null>(null);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);
  const { onExit } = useSessions();

  const fetchNow = useCallback(async () => {
    try {
      const url = `/api/coding-agent/session/latest?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}`;
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: await authHeader(),
      });
      // Token may have expired — drop the cache so the next fetch renews it.
      if (r.status === 401) clearAccessToken();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { session: LatestAgentSession | null };
      if (aliveRef.current) setSession(data.session);
    } catch {
      // Keep whatever we had; the next trigger will retry.
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [copy, bp]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    void fetchNow();
    return () => {
      aliveRef.current = false;
    };
  }, [fetchNow]);

  // A session ending in this scope is the one event that changes the answer
  // (a fresh conversation now exists on disk, or the title moved on).
  useEffect(
    () =>
      onExit((s) => {
        if (s.copy === copy && s.bp === bp) void fetchNow();
      }),
    [onExit, copy, bp, fetchNow],
  );

  return { session, loading };
}
