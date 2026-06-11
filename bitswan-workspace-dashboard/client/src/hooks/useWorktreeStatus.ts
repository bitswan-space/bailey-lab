import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChangedFile } from '@/lib/api';

interface Result {
  changed: ChangedFile[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Per-worktree change list (paths + A/M/D + +adds/-dels). Focus refetch. */
export function useWorktreeStatus(worktree: string): Result {
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.worktreeFiles.status(worktree);
      if (aliveRef.current) setChanged(r.changed);
    } catch {
      // non-fatal
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [worktree]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { changed, loading, refresh };
}
