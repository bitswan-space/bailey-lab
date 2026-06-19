import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { TopNav } from '@/components/workspace/TopNav';
import {
  WorkspaceProvider,
  useProcesses,
  useCopies,
} from '@/components/workspace/WorkspaceProvider';
import { SessionProvider } from '@/components/agents/SessionProvider';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceView } from '@/components/views/WorkspaceView';
import { api } from '@/lib/api';
import { getUrlParam, setUrlParams } from '@/lib/urlState';
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

// Keys for sessionStorage. We persist the selected BP, copy and tab so
// the user lands back on the same view after a page reload — chiefly the
// cold-start reload that Vite HMR triggers in dev when gitops reconfigures
// Traefik while spinning up the coding-agent container.
const BP_STORAGE_KEY = 'dashboard.bpId';
const WT_STORAGE_KEY = 'dashboard.copy';
const TAB_STORAGE_KEY = 'dashboard.flowTab';

const FLOW_TABS: FlowTab[] = [
  'description',
  'agent',
  'requirements',
  'sync-deploy',
  'deployments',
];

// Page-scoped query params owned by the individual tab components. They're
// cleared when the user switches tabs so the URL never carries a previous
// page's state (e.g. a Deployments `section` lingering on the Agent tab).
const PAGE_SCOPED_PARAMS = [
  'stage',
  'section',
  'inspect',
  'panel',
  'file',
  'sub',
  'diff',
  'view',
  'filter',
  'q',
  'dialog',
  'snap',
];

// The URL query string is the source of truth for the selected BP, copy and
// tab — that's what makes a pasted link reproduce the exact view. We fall
// back to sessionStorage (last session) only when the param is absent, then
// immediately reflect the resolved choice back into the URL.

// eslint-disable-next-line no-restricted-syntax -- null = no persisted choice
function readPersistedBpId(): string | null {
  const fromUrl = getUrlParam('bp');
  if (fromUrl) return fromUrl;
  try {
    return sessionStorage.getItem(BP_STORAGE_KEY);
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-restricted-syntax -- null = no persisted choice
function readPersistedCopy(): string | null {
  const fromUrl = getUrlParam('copy');
  if (fromUrl) return fromUrl;
  try {
    return sessionStorage.getItem(WT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readPersistedTab(): FlowTab {
  const fromUrl = getUrlParam('tab');
  if (fromUrl && (FLOW_TABS as string[]).includes(fromUrl)) return fromUrl as FlowTab;
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
  const { copies: copiesSnapshot } = useCopies();
  // Memoise the empty-array fallback so the array identity is stable.
  const allBps = useMemo(() => processes ?? [], [processes]);
  const copies = useMemo(() => copiesSnapshot ?? [], [copiesSnapshot]);
  // eslint-disable-next-line no-restricted-syntax -- null = "not yet selected"
  const [bpId, setBpId] = useState<string | null>(readPersistedBpId);
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  const [copy, setCopy] = useState<string | null>(readPersistedCopy);
  const [tab, setTab] = useState<FlowTab>(readPersistedTab);
  // The logged-in user's own copy, created on first login by GET /api/me and
  // auto-selected below. null until resolved; `myCopyResolved` gates copy
  // auto-selection so we don't briefly land on someone else's copy first.
  // eslint-disable-next-line no-restricted-syntax -- null = not yet resolved
  const [myCopy, setMyCopy] = useState<string | null>(null);
  const [myCopyResolved, setMyCopyResolved] = useState(false);
  // The signed-in user's role (admin | auditor | member) — surfaced in the top
  // bar so it's always clear which permissions the UI is showing.
  const [role, setRole] = useState<'admin' | 'auditor' | 'member'>('member');

  // On load, resolve the user's personal copy (creating it on first login).
  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((me) => {
        if (!cancelled) {
          setMyCopy(me?.copy ?? null);
          setRole(me?.role ?? 'member');
        }
      })
      .catch(() => {
        // No identity / gitops down — fall back to default copy selection.
      })
      .finally(() => {
        if (!cancelled) setMyCopyResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One-time cleanup of pre-redesign persistence keys.
  useEffect(() => {
    try {
      sessionStorage.removeItem('dashboard.scope');
      sessionStorage.removeItem('dashboard.copyTab');
    } catch {
      // ignore
    }
  }, []);

  // Mirror current selection to the URL (source of truth for deep links)
  // and to sessionStorage (last-session fallback) on change.
  useEffect(() => {
    setUrlParams({ bp: bpId });
    try {
      if (bpId) sessionStorage.setItem(BP_STORAGE_KEY, bpId);
      else sessionStorage.removeItem(BP_STORAGE_KEY);
    } catch {
      // ignore quota or unavailable
    }
  }, [bpId]);
  useEffect(() => {
    setUrlParams({ copy });
    try {
      if (copy) sessionStorage.setItem(WT_STORAGE_KEY, copy);
      else sessionStorage.removeItem(WT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [copy]);
  useEffect(() => {
    setUrlParams({ tab });
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  }, [tab]);

  // Browser back/forward: re-sync the top-level selection from the URL.
  useEffect(() => {
    const onPop = () => {
      setBpId(getUrlParam('bp'));
      setCopy(getUrlParam('copy'));
      const t = getUrlParam('tab');
      setTab(t && (FLOW_TABS as string[]).includes(t) ? (t as FlowTab) : 'description');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Switching tabs drops the previous page's scoped params so the URL stays
  // a clean, faithful description of what's on screen.
  const handleTab = useCallback((next: FlowTab) => {
    setTab(next);
    setUrlParams(Object.fromEntries(PAGE_SCOPED_PARAMS.map((k) => [k, null])));
  }, []);

  // The BP switcher lists every BP (main + copies; the processes feed is
  // already deduped by name). Keep `bpId` consistent: when the current BP
  // disappears, fall back to the first available — or clear if none.
  useEffect(() => {
    if (processes === null) return; // still loading; don't make decisions yet
    if (bpId && allBps.some((p) => p.id === bpId)) return;
    setBpId(allBps[0]?.id ?? null);
  }, [processes, allBps, bpId]);

  // Keep `copy` consistent with the snapshot, defaulting to the user's
  // OWN copy. Waits until `myCopy` is resolved before auto-selecting so a new
  // user doesn't briefly land on another user's copy. An optimistic selection
  // (the current value, or the user's own copy while it's still being created
  // and not yet in the snapshot) survives until the SSE feed delivers it.
  useEffect(() => {
    if (copiesSnapshot === null) return;
    if (!myCopyResolved) return;
    setCopy((cur) => {
      if (cur && (copiesSnapshot.some((w) => w.name === cur) || cur === myCopy))
        return cur;
      // Prefer the user's own copy (even before it appears in the snapshot, so
      // first-login selection sticks); otherwise fall back to the first copy.
      if (myCopy) return myCopy;
      return copiesSnapshot[0]?.name ?? null;
    });
  }, [copiesSnapshot, myCopy, myCopyResolved]);

  const bp = useMemo(
    () => allBps.find((b) => b.id === bpId) ?? null,
    [allBps, bpId],
  );
  const wt = useMemo(
    () => (copy ? copies.find((w) => w.name === copy) ?? null : null),
    [copy, copies],
  );

  const isLoading = processes === null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TopNav
        bps={allBps}
        activeBpId={bpId}
        onSelectBp={setBpId}
        copy={copy}
        copies={copies}
        onSelectCopy={setCopy}
        tab={tab}
        onTab={handleTab}
        role={role}
      />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading business processes…
        </div>
      ) : (
        <WorkspaceView bp={bp} wt={wt} tab={tab} onTab={handleTab} />
      )}
    </div>
  );
}
