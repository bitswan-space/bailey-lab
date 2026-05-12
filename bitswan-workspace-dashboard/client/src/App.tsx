import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { Sidebar } from '@/components/workspace/Sidebar';
import { TopBar } from '@/components/workspace/TopBar';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { Toaster } from '@/components/ui/sonner';
import { DeploymentsView } from '@/components/views/DeploymentsView';
import { WorktreeView } from '@/components/views/WorktreeView';
import { api } from '@/lib/api';
import type { BusinessProcess, Scope, Worktree } from '@/types';

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
  const [bps, setBps] = useState<BusinessProcess[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [bpId, setBpId] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>({ type: 'deployments' });

  // Load BPs once.
  useEffect(() => {
    let cancelled = false;
    api.businessProcesses().then((rows) => {
      if (cancelled) return;
      setBps(rows);
      const first = rows[0];
      if (first) setBpId((cur) => cur ?? first.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load worktrees when the selected BP changes.
  useEffect(() => {
    if (!bpId) {
      setWorktrees([]);
      return;
    }
    let cancelled = false;
    api
      .worktrees()
      .then((rows) => {
        if (cancelled) return;
        setWorktrees(rows);
        // If our current scope refers to a worktree that doesn't exist on the
        // new BP, reset to Deployments.
        setScope((cur) => {
          if (cur.type !== 'worktree') return cur;
          return rows.some((w) => w.name === cur.name) ? cur : { type: 'deployments' };
        });
      })
      .catch(() => setWorktrees([]));
    return () => {
      cancelled = true;
    };
  }, [bpId]);

  const bp = useMemo(() => bps.find((b) => b.id === bpId) ?? null, [bps, bpId]);
  const wt = useMemo(
    () =>
      scope.type === 'worktree' ? worktrees.find((w) => w.name === scope.name) ?? null : null,
    [scope, worktrees],
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar bps={bps} activeBpId={bpId} onSelect={setBpId} />
      <div className="flex min-w-0 flex-1 flex-col">
        {bp ? (
          <>
            <TopBar scope={scope} onScope={setScope} worktrees={worktrees} />
            {scope.type === 'deployments' ? (
              <DeploymentsView bp={bp} />
            ) : wt ? (
              <WorktreeView bp={bp} wt={wt} />
            ) : null}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {bps.length === 0
              ? 'No business processes found in this workspace.'
              : 'Select a business process from the sidebar.'}
          </div>
        )}
      </div>
    </div>
  );
}
