import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { Sidebar } from '@/components/workspace/Sidebar';
import { TopBar } from '@/components/workspace/TopBar';
import {
  WorkspaceProvider,
  useProcesses,
  useWorktrees,
} from '@/components/workspace/WorkspaceProvider';
import { Toaster } from '@/components/ui/sonner';
import { DeploymentsView } from '@/components/views/DeploymentsView';
import { WorktreeView } from '@/components/views/WorktreeView';
import type { Scope } from '@/types';

export function App() {
  return (
    <AuthGate>
      <WorkspaceProvider>
        <Shell />
        <Toaster position="bottom-right" richColors closeButton />
      </WorkspaceProvider>
    </AuthGate>
  );
}

function Shell() {
  const { processes } = useProcesses();
  const { worktrees: worktreesSnapshot } = useWorktrees();
  // Memoise the empty-array fallback so the array identity is stable; the
  // raw `??` on every render would force every downstream `useMemo` to
  // recompute.
  const allBps = useMemo(() => processes ?? [], [processes]);
  const worktrees = useMemo(() => worktreesSnapshot ?? [], [worktreesSnapshot]);
  // eslint-disable-next-line no-restricted-syntax -- null = "not yet selected"
  const [bpId, setBpId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>({ type: 'deployments' });

  // BPs visible in the sidebar are scoped to the current view:
  //   - Deployments scope → BPs present in main.
  //   - Worktree scope    → BPs present in that worktree.
  // A BP that only exists in a worktree is invisible from Deployments
  // (matches the user's mental model — promotion brings it into main).
  const visibleBps = useMemo(() => {
    if (scope.type === 'deployments') return allBps.filter((p) => p.inMain);
    return allBps.filter((p) => p.worktrees.includes(scope.name));
  }, [allBps, scope]);

  // Keep `bpId` consistent with what's visible in the sidebar. When the
  // current BP isn't in the filtered set (initial load, scope switch, or
  // BP removed), fall back to the first available — or clear if none.
  useEffect(() => {
    if (processes === null) return; // still loading; don't make decisions yet
    if (bpId && visibleBps.some((p) => p.id === bpId)) return;
    setBpId(visibleBps[0]?.id ?? null);
  }, [processes, visibleBps, bpId]);

  // Keep `scope` consistent with the worktree snapshot. Fires only when the
  // snapshot changes — not when scope itself changes — so an optimistic
  // setScope (e.g. just after creating a worktree) survives until the SSE
  // feed delivers the new entry.
  useEffect(() => {
    if (worktreesSnapshot === null) return;
    setScope((cur) => {
      if (cur.type !== 'worktree') return cur;
      return worktreesSnapshot.some((w) => w.name === cur.name)
        ? cur
        : { type: 'deployments' };
    });
  }, [worktreesSnapshot]);

  const bp = useMemo(
    () => visibleBps.find((b) => b.id === bpId) ?? null,
    [visibleBps, bpId],
  );
  const wt = useMemo(
    () =>
      scope.type === 'worktree' ? worktrees.find((w) => w.name === scope.name) ?? null : null,
    [scope, worktrees],
  );

  const isLoading = processes === null;
  const emptyMessage = isLoading
    ? 'Loading business processes…'
    : allBps.length === 0
      ? 'No business processes found in this workspace.'
      : scope.type === 'worktree'
        ? `No business processes in worktree "${scope.name}".`
        : 'No business processes in main.';

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        bps={visibleBps}
        activeBpId={bpId}
        onSelect={setBpId}
        {...(scope.type === 'worktree' ? { worktree: scope.name } : {})}
        onCreated={(name) => setBpId(name)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar scope={scope} onScope={setScope} worktrees={worktrees} />
        {scope.type === 'worktree' && wt ? (
          // Always render the worktree view, even when no BP is selected —
          // the user needs the Delete-worktree button reachable on empty
          // worktrees too.
          <WorktreeView bp={bp} wt={wt} />
        ) : bp ? (
          scope.type === 'deployments' ? (
            <DeploymentsView bp={bp} />
          ) : null
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
