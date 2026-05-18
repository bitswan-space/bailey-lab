import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AddRequirementRequest,
  type Requirement,
  type UpdateRequirementRequest,
} from '@/lib/api';

interface Result {
  requirements: Requirement[];
  loading: boolean;
  refresh: () => Promise<void>;
  add: (body: AddRequirementRequest) => Promise<Requirement>;
  update: (id: string, patch: UpdateRequirementRequest) => Promise<Requirement>;
  remove: (id: string) => Promise<void>;
}

/**
 * Per-(worktree, BP) testable requirements. The agent CLI and the
 * dashboard both write to the same TOML file so we refresh on:
 *   - mount + each (worktree, bp) change
 *   - window focus (catch external edits from the CLI)
 *   - after every mutation (optimistic+refetch keeps the local list honest)
 */
export function useRequirements(worktree: string, bp: string): Result {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.requirements.list(bp, worktree);
      if (aliveRef.current) setRequirements(data);
    } catch {
      // Swallow — focus/poll callers should not crash the tab; the next
      // call will try again. A red banner on persistent failure could
      // be added later if needed.
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [worktree, bp]);

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

  const add = useCallback(
    async (body: AddRequirementRequest) => {
      const created = await api.requirements.add(bp, worktree, body);
      // Optimistic insert: append, then refetch in the background to pick
      // up the canonical ordering from the file.
      setRequirements((prev) => [...prev, created]);
      void refresh();
      return created;
    },
    [bp, worktree, refresh],
  );

  const update = useCallback(
    async (id: string, patch: UpdateRequirementRequest) => {
      const next = await api.requirements.update(bp, worktree, id, patch);
      setRequirements((prev) => prev.map((r) => (r.id === id ? next : r)));
      return next;
    },
    [bp, worktree],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.requirements.remove(bp, worktree, id);
      setRequirements((prev) => prev.filter((r) => r.id !== id));
    },
    [bp, worktree],
  );

  return { requirements, loading, refresh, add, update, remove };
}
