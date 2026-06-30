import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AddRequirementRequest,
  type Requirement,
  type RunTestsResponse,
  type UpdateRequirementRequest,
} from '@/lib/api';

interface Result {
  requirements: Requirement[];
  loading: boolean;
  refresh: () => Promise<void>;
  add: (body: AddRequirementRequest) => Promise<Requirement>;
  update: (id: string, patch: UpdateRequirementRequest) => Promise<Requirement>;
  remove: (id: string) => Promise<void>;
  /** Run the tests (one requirement when `id` is given, else all) and adopt
   *  the canonical statuses the CLI wrote back. */
  runTests: (id?: string) => Promise<RunTestsResponse>;
}

/**
 * Per-(copy, BP) testable requirements. The agent CLI and the
 * dashboard both write to the same TOML file so we refresh on:
 *   - mount + each (copy, bp) change
 *   - window focus (catch external edits from the CLI)
 *   - after every mutation (optimistic+refetch keeps the local list honest)
 */
export function useRequirements(copy: string, bp: string): Result {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.requirements.list(bp, copy);
      if (aliveRef.current) setRequirements(data);
    } catch {
      // Swallow — focus/poll callers should not crash the tab; the next
      // call will try again. A red banner on persistent failure could
      // be added later if needed.
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [copy, bp]);

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
      const created = await api.requirements.add(bp, copy, body);
      // Optimistic insert: append, then refetch in the background to pick
      // up the canonical ordering from the file.
      setRequirements((prev) => [...prev, created]);
      void refresh();
      return created;
    },
    [bp, copy, refresh],
  );

  const update = useCallback(
    async (id: string, patch: UpdateRequirementRequest) => {
      const next = await api.requirements.update(bp, copy, id, patch);
      setRequirements((prev) => prev.map((r) => (r.id === id ? next : r)));
      return next;
    },
    [bp, copy],
  );

  const remove = useCallback(
    async (id: string) => {
      await api.requirements.remove(bp, copy, id);
      setRequirements((prev) => prev.filter((r) => r.id !== id));
    },
    [bp, copy],
  );

  const runTests = useCallback(
    async (id?: string) => {
      const res = await api.requirements.runTests(bp, copy, id);
      // Adopt the server's canonical list (the CLI just wrote pass/fail into
      // the TOML) so badges flip without a separate refetch.
      if (aliveRef.current) setRequirements(res.requirements);
      return res;
    },
    [bp, copy],
  );

  return { requirements, loading, refresh, add, update, remove, runTests };
}
