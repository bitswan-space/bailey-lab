import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Result {
  diff: string;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches the unified diff for one file in a worktree. `path` being
 * null clears the buffer — the parent can render "nothing selected".
 */
export function useFileDiff(worktree: string, path: string | null): Result {
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!path) {
      setDiff('');
      return;
    }
    setLoading(true);
    try {
      const r = await api.worktreeFiles.diff(worktree, path);
      if (aliveRef.current) setDiff(r.diff);
    } catch {
      if (aliveRef.current) setDiff('');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [worktree, path]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { diff, loading, refresh };
}
