import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { SessionExpiredBanner } from '@/components/auth/SessionExpiredBanner';
import { TopNav } from '@/components/workspace/TopNav';
import {
  WorkspaceProvider,
  useProcesses,
  useCopies,
  useDeployDone,
} from '@/components/workspace/WorkspaceProvider';
import { SessionProvider, useSessions } from '@/components/agents/SessionProvider';
import { WorkspaceView } from '@/components/views/WorkspaceView';
import { DeleteCopyDialog } from '@/components/workspace/DeleteCopyDialog';
import { ExperimentBanner } from '@/components/workspace/ExperimentBanner';
import { TaskQueuePanel } from '@/components/workspace/TaskQueuePanel';
import { ViewingBanner } from '@/components/workspace/ViewingBanner';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { watchDeployTask } from '@/lib/deployBp';
import { SessionExpiredError } from '@/lib/session';
import { getUrlParam, setUrlParams } from '@/lib/urlState';
import type { Copy, FlowTab } from '@/types';

export function App() {
  return (
    <AuthGate>
      <SessionExpiredBanner />
      <WorkspaceProvider>
        <SessionProvider>
          <Shell />
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
  'get-started',
  'sync',
  'description',
  'agent',
  'requirements',
  'deploy',
  'deployments',
];

// Tab values that have been renamed since links were shared and sessions
// persisted. An old `?tab=sync-deploy` URL (or sessionStorage entry) must land
// on the tab that took its place, not on the default.
const LEGACY_TAB_ALIASES: Record<string, FlowTab> = { 'sync-deploy': 'deploy' };

/** A raw tab value (URL or sessionStorage) resolved to a current tab, or null
 *  when it names nothing we render. */
// eslint-disable-next-line no-restricted-syntax -- null = not a known tab
function normalizeTab(raw: string | null | undefined): FlowTab | null {
  if (!raw) return null;
  const value = LEGACY_TAB_ALIASES[raw] ?? raw;
  return (FLOW_TABS as string[]).includes(value) ? (value as FlowTab) : null;
}

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
  const fromUrl = normalizeTab(getUrlParam('tab'));
  if (fromUrl) return fromUrl;
  try {
    const stored = normalizeTab(sessionStorage.getItem(TAB_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // ignore malformed entries
  }
  return 'description';
}

/**
 * "Does main carry commits this copy hasn't pulled?" — read on demand for ONE
 * copy, never precomputed.
 *
 * The `copies` SSE snapshot used to answer this for every copy: gitops
 * computed ahead/behind per copy × per business process, a `git fetch` each,
 * on every git event (75 seconds on a 13-copy × 21-BP workspace) to feed a UI
 * that only ever shows one copy. The snapshot now carries no counts at all,
 * and this hook asks `GET /api/copies/:name/behind` for the single copy that
 * can show the Sync step.
 *
 * Reads are coalesced: at most one request in flight, and if triggers arrive
 * while one is running, exactly one more runs after it (no polling, no
 * timers). A read that FAILS is reported as an error, never as zero — the
 * caller decides what to do with "unknown", and the difference between "you
 * have nothing to pull" and "we couldn't find out" is the whole point.
 *
 * @param copy The copy to measure, or null to measure nothing.
 */
function useBehindMain(
  // eslint-disable-next-line no-restricted-syntax -- null = nothing to measure
  copy: string | null,
): {
  /** Commits on main this copy lacks. null = not read yet (or no target). */
  // eslint-disable-next-line no-restricted-syntax -- null = no reading yet
  behind: number | null;
  /** Why the last read failed. null = the reading above is trustworthy. */
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  error: string | null;
  /** Re-read now (coalesced). Call it on every event that can move main's or
   *  the copy's refs. */
  recheck: () => void;
} {
  // eslint-disable-next-line no-restricted-syntax -- null = no reading yet
  const [behind, setBehind] = useState<number | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);
  // The copy the in-flight read is about; a late answer for a copy we've since
  // left is discarded rather than shown against the new one.
  // eslint-disable-next-line no-restricted-syntax -- null = nothing to measure
  const targetRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const againRef = useRef(false);

  const recheck = useCallback(() => {
    const target = targetRef.current;
    if (!target) return;
    if (runningRef.current) {
      // Collapse any number of triggers during a read into ONE follow-up read,
      // so a burst of git events can't queue a burst of requests.
      againRef.current = true;
      return;
    }
    runningRef.current = true;
    const run = (name: string) => {
      api.copyFiles
        .behind(name)
        .then((r) => {
          if (targetRef.current !== name) return;
          setBehind(r.behind);
          setError(null);
        })
        .catch((err: unknown) => {
          if (targetRef.current !== name) return;
          // An expired session is surfaced app-wide by the re-login banner;
          // the previous reading stands until the user is back.
          if (err instanceof SessionExpiredError) return;
          setBehind(null);
          setError(errorMessage(err));
        })
        .finally(() => {
          const next = againRef.current ? targetRef.current : null;
          againRef.current = false;
          if (next) {
            run(next);
            return;
          }
          runningRef.current = false;
        });
    };
    run(target);
  }, []);

  // Switching copies invalidates the reading: the old copy's count says
  // nothing about the new one, so drop it rather than showing it for a beat.
  useEffect(() => {
    targetRef.current = copy;
    setBehind(null);
    setError(null);
  }, [copy]);

  return { behind, error, recheck };
}

function Shell() {
  const { processes } = useProcesses();
  const { copies: copiesSnapshot } = useCopies();
  const deployDone = useDeployDone();
  const { startMergeBackSession } = useSessions();
  // Memoise the empty-array fallback so the array identity is stable.
  const allBps = useMemo(() => processes ?? [], [processes]);
  const copies = useMemo(() => copiesSnapshot ?? [], [copiesSnapshot]);
  // eslint-disable-next-line no-restricted-syntax -- null = "not yet selected"
  const [bpId, setBpId] = useState<string | null>(readPersistedBpId);
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  const [copy, setCopy] = useState<string | null>(readPersistedCopy);
  const [tab, setTab] = useState<FlowTab>(readPersistedTab);
  // The "new business process" dialog lives in TopNav, but it can be opened
  // from more than one place (the BP switcher AND the empty-state body), so
  // its open flag is hoisted here.
  const [newBpOpen, setNewBpOpen] = useState(false);
  // A business process being cloned into the copy in view (TopNav's selector
  // starts it). Routine inside an experiment: it is created carrying ONLY the
  // process it was started on, and any other one is materialized on first open,
  // so the body must say "adding…" rather than "it isn't in this copy".
  // eslint-disable-next-line no-restricted-syntax -- null = nothing in flight
  const [addingBp, setAddingBp] = useState<string | null>(null);
  // The logged-in user's own copy, created on first login by GET /api/me and
  // auto-selected below. null until resolved; `myCopyResolved` gates copy
  // auto-selection so we don't briefly land on someone else's copy first.
  // eslint-disable-next-line no-restricted-syntax -- null = not yet resolved
  const [myCopy, setMyCopy] = useState<string | null>(null);
  const [myCopyResolved, setMyCopyResolved] = useState(false);
  // The signed-in user's email — the identity gitops stamps copies with.
  const [myEmail, setMyEmail] = useState('');
  // The signed-in user's role (admin | auditor | member) — surfaced in the top
  // bar so it's always clear which permissions the UI is showing.
  const [role, setRole] = useState<'admin' | 'auditor' | 'member'>('member');
  // The experiment pending discard confirmation. null = dialog closed.
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  const [discardTarget, setDiscardTarget] = useState<Copy | null>(null);
  // A merge-back is in flight (the experiment banner's button is busy).
  const [merging, setMerging] = useState(false);
  // Bumped on every editor save so copy-dirtiness consumers refetch (the
  // SSE snapshot only refreshes on git events, not file writes).
  const [copyEditNonce, setCopyEditNonce] = useState(0);
  // Bumped when one of the user's OWN git actions finishes (pull, merge-back)
  // so the behind-main check re-reads immediately instead of waiting for the
  // next event — that's what makes the Sync step disappear right after a pull.
  const [syncCheckNonce, setSyncCheckNonce] = useState(0);

  // On load, resolve the user's personal copy (creating it on first login).
  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((me) => {
        if (!cancelled) {
          setMyCopy(me?.copy ?? null);
          setMyEmail(me?.email ?? '');
          setRole(me?.role ?? 'member');
        }
      })
      .catch((err: unknown) => {
        // Without an identity the selection falls back to the first copy in the
        // snapshot — i.e. somebody else's. Say so rather than quietly putting
        // the user somewhere that isn't theirs.
        toast.error(
          `Couldn't work out which copy is yours: ${errorMessage(err)}. ` +
            `Reload once gitops is reachable — until then you may be looking ` +
            `at someone else's copy.`,
          { duration: 12000 },
        );
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
      setTab(normalizeTab(getUrlParam('tab')) ?? 'description');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Wake-on-load: opening a BP in a copy rehydrates its (possibly evicted)
  // live-dev instance and marks it recently-used, so the preview is warm by the
  // time the user opens it and stays out of the LRU eviction set while in view.
  // Fire-and-forget; the server no-ops a running instance (just a touch).
  useEffect(() => {
    if (!bpId) return;
    api.wakeLiveDev(bpId, copy).catch(() => {});
  }, [bpId, copy]);

  // Switching tabs drops the previous page's scoped params so the URL stays
  // a clean, faithful description of what's on screen.
  const handleTab = useCallback((next: FlowTab) => {
    setTab(next);
    setUrlParams(Object.fromEntries(PAGE_SCOPED_PARAMS.map((k) => [k, null])));
  }, []);

  // A just-created BP: its name is selected optimistically the instant the
  // create call returns, but it isn't in the `processes` SSE snapshot yet. The
  // consistency effect below must NOT clobber that selection back to the first
  // BP while we wait for the feed — otherwise creating "memory6" lands you on
  // whatever sorts first. Cleared once the BP actually appears. Mirrors the
  // copy effect's optimistic-survival right below.
  const justCreatedBpRef = useRef<string | null>(null);
  const handleBpCreated = useCallback((name: string) => {
    justCreatedBpRef.current = name;
    setBpId(name);
    handleTab('description');
  }, [handleTab]);

  // The processes feed aggregates every scope, so a business process created
  // inside somebody's experiment would otherwise turn up in EVERYONE's
  // switcher. Hide the ones that live only in experiments that aren't the
  // viewer's — a pure metadata comparison (kind + parent), never a guess from
  // names. A BP in main, in any user copy, in one of my own experiments, or in
  // the copy I'm looking at right now stays visible.
  const bps = useMemo(() => {
    const byName = new Map(copies.map((c) => [c.name, c]));
    return allBps.filter((p) => {
      if (p.inMain) return true;
      return p.copies.some((name) => {
        const c = byName.get(name);
        if (!c || c.kind !== 'experiment') return true;
        return c.parent === myCopy || name === copy;
      });
    });
  }, [allBps, copies, myCopy, copy]);

  // The BP switcher lists every visible BP (main + copies; the processes feed
  // is already deduped by name). Keep `bpId` consistent: when the current BP
  // disappears, fall back to the first available — or clear if none. A
  // just-created BP survives until the SSE feed delivers it.
  useEffect(() => {
    if (processes === null) return; // still loading; don't make decisions yet
    if (bpId && bps.some((p) => p.id === bpId)) {
      justCreatedBpRef.current = null; // it's in the feed now; stop protecting it
      return;
    }
    if (bpId && bpId === justCreatedBpRef.current) return; // created, not in feed yet
    setBpId(bps[0]?.id ?? null);
  }, [processes, bps, bpId]);

  // Copies whose delete was ACCEPTED but that may still linger in the SSE
  // snapshot while the async teardown runs — the selection must never land on
  // one. Tombstones clear once the feed confirms the copy is gone (so a
  // recreated same-name personal copy isn't excluded forever).
  const deletedCopiesRef = useRef<Set<string>>(new Set());
  const handleCopyDeleted = useCallback(
    (name: string) => {
      deletedCopiesRef.current.add(name);
      // Deleting your own copy: stop treating it as the sticky default; a
      // fresh personal copy is re-created by /api/me on the next visit.
      if (myCopy === name) setMyCopy(null);
      setCopy((cur) => {
        if (cur !== name) return cur;
        // Discarding an experiment drops you back into your own copy — the
        // place it branched from — not onto whatever copy sorts first.
        if (myCopy && myCopy !== name) return myCopy;
        const next = copies.find((c) => c.name !== name);
        return next ? next.name : null;
      });
    },
    [copies, myCopy],
  );

  // Keep `copy` consistent with the snapshot, defaulting to the user's
  // OWN copy. Waits until `myCopy` is resolved before auto-selecting so a new
  // user doesn't briefly land on another user's copy. An optimistic selection
  // (the current value, or the user's own copy while it's still being created
  // and not yet in the snapshot) survives until the SSE feed delivers it.
  useEffect(() => {
    if (copiesSnapshot === null) return;
    if (!myCopyResolved) return;
    // Clear tombstones the feed has confirmed gone.
    for (const name of [...deletedCopiesRef.current]) {
      if (!copiesSnapshot.some((w) => w.name === name))
        deletedCopiesRef.current.delete(name);
    }
    const available = copiesSnapshot.filter(
      (w) => !deletedCopiesRef.current.has(w.name),
    );
    setCopy((cur) => {
      // A selection on a mid-teardown copy must move off it now, not when the
      // snapshot finally drops it.
      const kept = cur && !deletedCopiesRef.current.has(cur) ? cur : null;
      if (kept && (available.some((w) => w.name === kept) || kept === myCopy))
        return kept;
      // Prefer the user's own copy (even before it appears in the snapshot, so
      // first-login selection sticks); otherwise fall back to the first copy.
      if (myCopy && !deletedCopiesRef.current.has(myCopy)) return myCopy;
      return available[0]?.name ?? null;
    });
  }, [copiesSnapshot, myCopy, myCopyResolved]);

  // Pull main's new commits into a copy (rebase it onto main). A clean pull
  // redeploys live-dev only for BPs whose image dir changed; a conflict can't be
  // resolved automatically, so we route the user to the Coding Agent on that
  // copy to finish the rebase by hand.
  const handlePullCopy = useCallback(
    async (copyName: string) => {
      const id = `pull-copy-${copyName}`;
      toast.loading(`Pulling main into ${copyName}…`, {
        id,
        duration: Infinity,
      });
      try {
        const res = await api.copyFiles.rebase(copyName);
        if (res.status === 'noop') {
          toast.success(`${copyName} is already up to date with main`, {
            id,
            duration: 4000,
          });
          return;
        }
        if (res.status === 'needs_rebase') {
          toast.error(`${copyName}: ${res.message}`, { id, duration: 10000 });
          // Hand off to the Coding Agent on this copy to resolve the conflict.
          setCopy(copyName);
          handleTab('agent');
          return;
        }
        toast.success(res.message, { id, duration: 6000 });
        (res.deploy_task_ids ?? []).forEach((tid: string, i: number) => {
          void watchDeployTask(tid, `${id}-deploy-${i}`, {
            loading: `Redeploying ${copyName} live-dev…`,
            success: `${copyName} live-dev updated`,
            failurePrefix: `Live-dev redeploy for ${copyName} failed`,
          });
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          // The app-wide re-login banner already prompts; don't pile on.
          toast.dismiss?.(id);
          return;
        }
        toast.error(`Failed to pull main into ${copyName}: ${String(err)}`, {
          id,
          duration: 8000,
        });
      } finally {
        // The copy's refs just moved (or provably didn't) — re-read the
        // behind-main count now so the Sync step goes away without waiting for
        // the next SSE event. Also correct on failure: the pull may have got
        // part-way.
        setSyncCheckNonce((n) => n + 1);
      }
    },
    [handleTab],
  );

  const bp = useMemo(
    () => bps.find((b) => b.id === bpId) ?? null,
    [bps, bpId],
  );
  const wt = useMemo(
    () => (copy ? copies.find((w) => w.name === copy) ?? null : null),
    [copy, copies],
  );

  // Where the user is, from explicit metadata only. Their own copy is the
  // everyday case; an experiment is one of their side branches off it;
  // anything else is somebody else's (or a legacy copy reached by URL) and
  // gets the "you are viewing" banner.
  const isMyCopy = copy !== null && copy === myCopy;
  const isMyExperiment =
    wt?.kind === 'experiment' &&
    !!myCopy &&
    wt.parent === myCopy &&
    // gitops also records the owner; when it's there it must agree. An
    // unresolved identity never hides your own experiment from you.
    (!wt.owner || !myEmail || wt.owner.toLowerCase() === myEmail.toLowerCase());
  const isColleagueView = copy !== null && !isMyCopy && !isMyExperiment;

  // Sync only pulls main into your OWN copy, so that is the only copy whose
  // behind-count is ever read — never an experiment's, never a colleague's.
  const behindTarget = isMyCopy ? myCopy : null;
  const {
    behind: behindMain,
    error: behindError,
    recheck: recheckBehind,
  } = useBehindMain(behindTarget);

  // Every event that can move main's refs or the copy's re-reads the count:
  //  - `copiesSnapshot` identity changes on every `copies` SSE event, which is
  //    how the two-user dance works — a colleague deploying to main fires it,
  //    and the Sync step must appear here within a couple of seconds.
  //  - `deployDone` covers a deploy finishing (main just moved, whoever did
  //    it), including the user's own from the Deploy tab.
  //  - `syncCheckNonce` is bumped by the user's own pull / merge-back so the
  //    step disappears the moment their action lands.
  // The hook coalesces, so overlapping triggers cost at most one extra read.
  useEffect(() => {
    recheckBehind();
  }, [recheckBehind, behindTarget, copiesSnapshot, deployDone, syncCheckNonce]);

  // Fail loudly. The Sync step's existence hangs off this count, so a read we
  // couldn't make is said out loud and the step is OFFERED anyway: hiding the
  // only route to a pull because we don't know is the silent fallback this
  // whole change removes. Opening Sync then shows the live per-process
  // breakdown, which is authoritative either way.
  const syncVisible =
    isMyCopy && (behindError !== null || (behindMain !== null && behindMain > 0));

  // One notification, updated in place by id — a persistent failure re-checked
  // on every git event must not become a wall of identical rows, and a
  // recovery must retract the warning instead of leaving it standing.
  const behindErrorReportedRef = useRef(false);
  useEffect(() => {
    if (behindError !== null) {
      behindErrorReportedRef.current = true;
      toast.error(
        `Couldn't read whether main has changes your copy hasn't pulled yet: ` +
          `${behindError}`,
        {
          id: 'copy-behind-check',
          description:
            'The Sync step stays available while this is unknown — open it to ' +
            'see the live per-process breakdown, or reload once gitops is reachable.',
        },
      );
      return;
    }
    if (behindErrorReportedRef.current && behindMain !== null) {
      behindErrorReportedRef.current = false;
      toast.success('Sync status is readable again', {
        id: 'copy-behind-check',
        description:
          behindMain > 0
            ? `Main has ${behindMain} change(s) your copy hasn't pulled yet.`
            : 'Your copy has everything on main.',
      });
    }
  }, [behindError, behindMain]);

  // Leaving a tab stranded is worse than moving the user: when the Sync step
  // disappears (pulled, or switched to someone else's copy), or Deploy does
  // (entered an experiment), fall back to Description.
  // ...but not before we know: on a reload the tab is restored from the URL
  // while the behind-main read is still in flight, and evicting the user from a
  // step that does exist makes the shared link look broken. On someone else's
  // copy there is nothing to wait for — the step can't exist there at all.
  const behindResolved =
    !isMyCopy || behindMain !== null || behindError !== null;
  useEffect(() => {
    if (tab === 'sync' && behindResolved && !syncVisible) handleTab('description');
  }, [tab, behindResolved, syncVisible, handleTab]);
  useEffect(() => {
    if (tab === 'deploy' && isMyExperiment) handleTab('description');
  }, [tab, isMyExperiment, handleTab]);

  // Merge an experiment back into the copy it branched off. A clean merge
  // fast-forwards the parent branch and redeploys the parent's live-dev; a
  // conflict means the experiment has to be rebased onto the parent first,
  // which the coding agent does ON THE EXPERIMENT (same shape as the
  // pull-conflict handoff above).
  const handleMergeBack = useCallback(async () => {
    if (!wt || !wt.parent || merging) return;
    const name = wt.name;
    const parent = wt.parent;
    const label = wt.title ?? name;
    const id = `merge-parent-${name}`;
    setMerging(true);
    toast.loading(`Merging “${label}” back into your copy…`, {
      id,
      duration: Infinity,
    });
    // Merging is how an experiment ENDS: its work lands in the parent, the
    // experiment is discarded and the user is back on their own copy. A `noop`
    // reaches the same end — the parent already has everything this experiment
    // holds (a concurrent merge, or a retry after one that already landed), so
    // there is nothing left to lose by closing it. Leaving the user sitting in
    // a finished experiment is the bug the user hit.
    const finishExperiment = async (message: string) => {
      toast.success(message, { id, duration: 6000 });
      // Land on the parent first: the work is already there, so the user
      // belongs on their own copy whether or not the teardown succeeds.
      setCopy(parent);
      try {
        // deleteCopy resolves on 4xx too (owner/kind guards) — check, never
        // assume it worked.
        const r = await api.deleteCopy(name);
        if (r.status >= 400) {
          toast.error(`Merged, but discarding “${label}” failed`, {
            description: r.error ?? r.body?.detail ?? `HTTP ${r.status}`,
            duration: 10000,
          });
          return;
        }
        // Accepted: tombstone it so the selection can't drift back onto a copy
        // that's mid-teardown while the SSE feed still lists it.
        handleCopyDeleted(name);
      } catch (err) {
        toast.error(
          `Merged, but discarding “${label}” failed: ${errorMessage(err)}`,
          { duration: 10000 },
        );
      }
    };

    try {
      const res = await api.copyFiles.mergeToParent(name);
      if (res.status === 'noop') {
        await finishExperiment(
          `“${label}” was already in your copy — experiment closed`,
        );
        return;
      }
      if (res.status === 'needs_rebase') {
        toast.error(`“${label}”: ${res.message}`, { id, duration: 10000 });
        if (bpId) {
          // The agent works inside the experiment, rebasing it onto the
          // parent branch; the merge fast-forwards once it's done.
          await startMergeBackSession(name, bpId, parent).catch((err: unknown) => {
            toast.error(
              `Failed to hand the rebase to the agent: ${errorMessage(err)}`,
            );
          });
        }
        handleTab('agent');
        return;
      }
      (res.deploy_task_ids ?? []).forEach((tid: string, i: number) => {
        void watchDeployTask(tid, `${id}-deploy-${i}`, {
          loading: `Redeploying your copy's live-dev…`,
          success: `Your copy's live-dev updated`,
          failurePrefix: `Live-dev redeploy for ${parent} failed`,
        });
      });
      await finishExperiment(`“${label}” merged — back on your copy`);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // The app-wide re-login banner already prompts; don't pile on.
        toast.dismiss?.(id);
        return;
      }
      toast.error(`Failed to merge “${label}” back: ${errorMessage(err)}`, {
        id,
        duration: 8000,
      });
    } finally {
      setMerging(false);
      // The parent copy (the user's own) has just taken the experiment's
      // commits — re-read its behind-main count.
      setSyncCheckNonce((n) => n + 1);
    }
  }, [wt, merging, bpId, startMergeBackSession, handleTab, handleCopyDeleted]);

  // Discarding an experiment is a real delete (branch, checkout, live-dev
  // containers), so it goes through the same warn+confirm dialog as any other
  // copy delete; handleCopyDeleted then moves the selection back to my copy.
  const handleDiscardExperiment = useCallback(() => {
    if (wt) setDiscardTarget(wt);
  }, [wt]);

  const isLoading = processes === null;

  // A copy name is selected but the copies snapshot doesn't carry it yet:
  // it's still being created server-side (the personal copy on first login
  // via /api/me, or a copy just created in the dialog — both select the name
  // optimistically before the SSE feed delivers it). WorkspaceView shows
  // "Creating copy…" instead of "No copy yet" while this holds (#160).
  const copyCreating = copy !== null && wt === null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TopNav
        bps={bps}
        activeBpId={bpId}
        onSelectBp={setBpId}
        onBpCreated={handleBpCreated}
        onAddingBpChange={setAddingBp}
        copy={copy}
        copies={copies}
        onSelectCopy={setCopy}
        myCopy={myCopy}
        syncVisible={syncVisible}
        isMyExperiment={isMyExperiment}
        tab={tab}
        onTab={handleTab}
        role={role}
        newBpOpen={newBpOpen}
        onNewBpOpenChange={setNewBpOpen}
      />
      {/* Where you are, right under the bar that says it: someone else's copy
          (awareness only — nothing is gated), or your own experiment (with the
          two ways out of it). */}
      {wt && isColleagueView && (
        <ViewingBanner
          copy={wt}
          {...(myCopy ? { onSwitchBack: () => setCopy(myCopy) } : {})}
        />
      )}
      {wt && isMyExperiment && (
        <ExperimentBanner
          copy={wt}
          merging={merging}
          refreshKey={copyEditNonce}
          onMergeBack={() => void handleMergeBack()}
          onDiscard={handleDiscardExperiment}
        />
      )}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading business processes…
        </div>
      ) : (
        <WorkspaceView
          bp={bp}
          wt={wt}
          copyCreating={copyCreating}
          addingBp={addingBp}
          tab={tab}
          onTab={handleTab}
          onCopyEdited={() => setCopyEditNonce((n) => n + 1)}
          onNewBp={() => setNewBpOpen(true)}
          isMyCopy={isMyCopy}
          isMyExperiment={isMyExperiment}
          onPullCopy={handlePullCopy}
          onMergeBack={() => void handleMergeBack()}
        />
      )}
      {/* Discarding an experiment: the same warn+confirm delete dialog every
          copy delete goes through — it names the unmerged and uncommitted work
          the discard would destroy. */}
      <DeleteCopyDialog
        copy={discardTarget}
        isOwnCopy={false}
        onClose={() => setDiscardTarget(null)}
        onDeleted={handleCopyDeleted}
      />
      {/* The single activity surface, anchored bottom-left: server-side git
          tasks AND transient notifications (former toasts) in one collapsible
          panel. */}
      <TaskQueuePanel />
    </div>
  );
}
