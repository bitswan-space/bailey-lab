import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MergePreview } from '@/lib/api';

interface Result {
  /** null until the first fetch resolves, and whenever it failed. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known yet
  preview: MergePreview | null;
  loading: boolean;
  /** '' when the last fetch succeeded. Never swallowed: the caller shows it. */
  error: string;
  refresh: () => Promise<void>;
}

/**
 * What merging an experiment back would carry into its PARENT copy, read live.
 *
 * The parent is the only meaningful baseline here: an experiment inherits its
 * parent's whole divergence from main, so a main-based signal (`useCopyStatus`)
 * says "there are changes" even for an experiment whose work is already merged.
 * Focus refetch, same as the other live copy reads.
 *
 * An EMPTY `copy` means "there is no copy to ask about yet" — the experiment is
 * still being created, so its name doesn't exist. Nothing is fetched and the
 * result stays `loading`: that is the honest state, and it is not the same
 * thing as "nothing to merge".
 */
export function useMergePreview(copy: string): Result {
  // eslint-disable-next-line no-restricted-syntax -- null = not known yet
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!copy) return; // nothing named yet — see the doc comment
    try {
      const r = await api.copyFiles.mergePreview(copy);
      if (aliveRef.current) {
        setPreview(r);
        setError('');
      }
    } catch (err) {
      if (aliveRef.current) {
        setPreview(null);
        setError(String(err));
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [copy]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    if (!copy) return; // no listener either — there is nothing to refetch
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { preview, loading, error, refresh };
}
