import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileContentResponse } from '@/lib/api';

interface Result {
  data: FileContentResponse | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /**
   * Suppress the focus-refetch while the editor has unsaved changes —
   * otherwise an in-progress edit would get clobbered by the file's
   * on-disk content (which may also be older than what's in the editor).
   * The viewer flips this on as soon as a buffer mutation happens.
   */
  setRefetchPaused: (paused: boolean) => void;
}

/**
 * Fetches a file's content once the user picks one in FileTree. `path`
 * being null means "no file open" — we return early and clear stale data.
 */
export function useFileContent(copy: string, path: string | null): Result {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  const pausedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const d = await api.copyFiles.content(copy, path);
      if (aliveRef.current) setData(d);
    } catch (err) {
      if (aliveRef.current) {
        setData({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [copy, path]);

  useEffect(() => {
    aliveRef.current = true;
    // Always do the initial fetch for the new path.
    void refresh();
    const onFocus = () => {
      if (pausedRef.current) return;
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const setRefetchPaused = useCallback((paused: boolean) => {
    pausedRef.current = paused;
  }, []);

  return { data, loading, refresh, setRefetchPaused };
}
