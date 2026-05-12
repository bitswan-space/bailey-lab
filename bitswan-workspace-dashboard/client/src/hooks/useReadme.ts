import { useEffect, useState } from 'react';
import { api } from '@/api';

export function useReadme(bpId: string | null | undefined): {
  content: string | null;
  loading: boolean;
} {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!bpId) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .readme(bpId)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch(() => {
        if (!cancelled) setContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bpId]);

  return { content, loading };
}
