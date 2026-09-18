import { useCallback, useEffect, useState } from 'react';
import { api, type AddRequirementRequest, type Requirement } from '@/lib/api';

/**
 * The BP's requirement CONTRACT: what the requirements are, not how they fared.
 *
 * Verdicts deliberately do not live here. They are runtime state produced by
 * running the tests, and they arrive over SSE — see `useBpTestState`. Keeping
 * the two apart is what stops the UI from ever showing a pass that came from
 * a file rather than a test run.
 */
export interface UseRequirements {
  requirements: Requirement[];
  loading: boolean;
  refresh: () => Promise<void>;
  add: (text: string, parent?: string) => Promise<Requirement>;
  update: (id: string, patch: { description?: string; accept?: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Ask gitops to start a run. Results arrive over SSE, not from this call. */
  runTests: (opts?: { id?: string; failedOnly?: boolean }) => Promise<void>;
}

export function useRequirements(copy: string, bp: string): UseRequirements {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRequirements(await api.requirements.list(bp, copy));
    } finally {
      setLoading(false);
    }
  }, [bp, copy]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The contract changes when someone edits it — including the agent, from its
  // own session — so re-read it when the window regains focus.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const add = useCallback(
    async (text: string, parent?: string) => {
      const body: AddRequirementRequest = { text, ...(parent ? { parent } : {}) };
      const created = await api.requirements.add(bp, copy, body);
      setRequirements((prev) => [...prev, created]);
      return created;
    },
    [bp, copy],
  );

  const update = useCallback(
    async (id: string, patch: { description?: string; accept?: boolean }) => {
      const next = await api.requirements.update(bp, copy, id, patch);
      setRequirements((prev) =>
        // PATCH responses aren't hasTest-annotated (only the list endpoint
        // scans the BP), so carry the previous value across.
        prev.map((r) => (r.id === id ? { ...next, hasTest: r.hasTest } : r)),
      );
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
    async (opts: { id?: string; failedOnly?: boolean } = {}) => {
      await api.requirements.runTests(bp, copy, opts);
    },
    [bp, copy],
  );

  return { requirements, loading, refresh, add, update, remove, runTests };
}
