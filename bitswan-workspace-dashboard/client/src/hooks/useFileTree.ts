import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FileTreeNode } from '@/lib/api';

interface Result {
  tree: FileTreeNode[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Per-worktree filesystem tree (sans hidden dirs). Refetches on focus. */
export function useFileTree(worktree: string): Result {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.worktreeFiles.tree(worktree);
      if (aliveRef.current) setTree(data);
    } catch {
      // see useRequirements / useAgentSessions — non-fatal
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

  return { tree, loading, refresh };
}
