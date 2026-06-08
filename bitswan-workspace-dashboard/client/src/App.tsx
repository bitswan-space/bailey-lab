import { useEffect, useMemo, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { TopNav } from '@/components/workspace/TopNav';
import {
  WorkspaceProvider,
  useProcesses,
  useWorktrees,
} from '@/components/workspace/WorkspaceProvider';
import { SessionProvider } from '@/components/agents/SessionProvider';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceView } from '@/components/views/WorkspaceView';
import type { FlowTab } from '@/types';

export function App() {
  return (
    <AuthGate>
      <WorkspaceProvider>
        <SessionProvider>
          <Shell />
          <Toaster position="bottom-right" richColors closeButton />
        </SessionProvider>
      </WorkspaceProvider>
    </AuthGate>
  );
}

// Keys for sessionStorage. We persist the selected BP, worktree and tab so
// the user lands back on the same view after a page reload — chiefly the
// cold-start reload that Vite HMR triggers in dev when gitops reconfigures
// Traefik while spinning up the coding-agent container.
const BP_STORAGE_KEY = 'dashboard.bpId';
const WT_STORAGE_KEY = 'dashboard.worktree';
const TAB_STORAGE_KEY = 'dashboard.flowTab';

const FLOW_TABS: FlowTab[] = [
  'description',
  'agent',
  'requirements',
  'sync-deploy',
  'deployments',
];

// eslint-disable-next-line no-restricted-syntax -- null = no persisted choice
function readPersistedBpId(): string | null {
  try {
    return sessionStorage.getItem(BP_STORAGE_KEY);
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-restricted-syntax -- null = no persisted choice
function readPersistedWorktree(): string | null {
  try {
    return sessionStorage.getItem(WT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readPersistedTab(): FlowTab {
  try {
    const raw = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (raw && (FLOW_TABS as string[]).includes(raw)) return raw as FlowTab;
  } catch {
    // ignore malformed entries
  }
  return 'description';
}

function Shell() {
  const { processes } = useProcesses();
  const { worktrees: worktreesSnapshot } = useWorktrees();
  // Memoise the empty-array fallback so the array identity is stable.
  const allBps = useMemo(() => processes ?? [], [processes]);
  const worktrees = useMemo(() => worktreesSnapshot ?? [], [worktreesSnapshot]);
  // eslint-disable-next-line no-restricted-syntax -- null = "not yet selected"
  const [bpId, setBpId] = useState<string | null>(readPersistedBpId);
  // eslint-disable-next-line no-restricted-syntax -- null = no worktree selected
  const [worktree, setWorktree] = useState<string | null>(readPersistedWorktree);
  const [tab, setTab] = useState<FlowTab>(readPersistedTab);

  // One-time cleanup of pre-redesign persistence keys.
  useEffect(() => {
    try {
      sessionStorage.removeItem('dashboard.scope');
      sessionStorage.removeItem('dashboard.worktreeTab');
    } catch {
      // ignore
    }
  }, []);

  // Mirror current selection to sessionStorage on change.
  useEffect(() => {
    try {
      if (bpId) sessionStorage.setItem(BP_STORAGE_KEY, bpId);
      else sessionStorage.removeItem(BP_STORAGE_KEY);
    } catch {
      // ignore quota or unavailable
    }
  }, [bpId]);
  useEffect(() => {
    try {
      if (worktree) sessionStorage.setItem(WT_STORAGE_KEY, worktree);
      else sessionStorage.removeItem(WT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [worktree]);
  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  }, [tab]);

  // The BP switcher lists every BP (main + worktrees; the processes feed is
  // already deduped by name). Keep `bpId` consistent: when the current BP
  // disappears, fall back to the first available — or clear if none.
  useEffect(() => {
    if (processes === null) return; // still loading; don't make decisions yet
    if (bpId && allBps.some((p) => p.id === bpId)) return;
    setBpId(allBps[0]?.id ?? null);
  }, [processes, allBps, bpId]);

  // Keep `worktree` consistent with the snapshot. Fires only when the
  // snapshot changes — not when the selection itself changes — so an
  // optimistic setWorktree (e.g. just after creating one) survives until
  // the SSE feed delivers the new entry. Auto-selects the first worktree
  // when none is selected.
  useEffect(() => {
    if (worktreesSnapshot === null) return;
    setWorktree((cur) => {
      if (cur && worktreesSnapshot.some((w) => w.name === cur)) return cur;
      return worktreesSnapshot[0]?.name ?? null;
    });
  }, [worktreesSnapshot]);

  const bp = useMemo(
    () => allBps.find((b) => b.id === bpId) ?? null,
    [allBps, bpId],
  );
  const wt = useMemo(
    () => (worktree ? worktrees.find((w) => w.name === worktree) ?? null : null),
    [worktree, worktrees],
  );

  const isLoading = processes === null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TopNav
        bps={allBps}
        activeBpId={bpId}
        onSelectBp={setBpId}
        worktree={worktree}
        worktrees={worktrees}
        onSelectWorktree={setWorktree}
        tab={tab}
        onTab={setTab}
      />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading business processes…
        </div>
      ) : (
        <WorkspaceView bp={bp} wt={wt} tab={tab} onTab={setTab} />
      )}
    </div>
  );
}
