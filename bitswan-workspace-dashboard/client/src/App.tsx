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
import { BusyOverlay } from '@/components/workspace/BusyOverlay';
import { ExperimentBanner } from '@/components/workspace/ExperimentBanner';
import { TaskQueuePanel } from '@/components/workspace/TaskQueuePanel';
import { ViewingBanner } from '@/components/workspace/ViewingBanner';
import {
  TakeVersionDialog,
  type TakeVersionSource,
} from '@/components/workspace/TakeVersionDialog';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { watchDeployTask } from '@/lib/deployBp';
import { SessionExpiredError } from '@/lib/session';
import { useBpDivergence } from '@/hooks/useBpDivergence';
import { useBpLabel } from '@/hooks/useBpLabel';
import { getUrlParam, setUrlParams } from '@/lib/urlState';
import type { BusinessProcess, Copy, FlowTab } from '@/types';

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
 * A copy transition in progress, and the exact condition that ends it.
 *
 * The app is locked (see `BusyOverlay`) for as long as one of these is set,
 * because between the click and the destination being fully renderable the
 * chrome can only show half of the answer. The lock lifts on a STATE
 * condition, not on a promise resolving: the request landing is necessary but
 * not sufficient — the copies feed still has to carry the destination before
 * the banner and the pipeline can agree about it.
 */
interface Busy {
  /** What the user is waiting for, named: "Starting experiment on Compost…". */
  label: string;
  /** The copy that must be both selected and present in the copies snapshot
   *  before the lock lifts. null while the server is still naming it — a new
   *  experiment's slug is generated server-side. */
  // eslint-disable-next-line no-restricted-syntax -- null = not named yet
  target: string | null;
  /** The request is still running. Set false by the caller when it resolves. */
  inFlight: boolean;
  /** Epoch ms the lock went up; the timeout below is measured from it. */
  startedAt: number;
  /** How long the destination may take to arrive before we stop waiting and
   *  say so. A lock with no cap is a hung app with a nicer sheet over it. */
  timeoutMs: number;
}

/**
 * The interface lock, handed to whatever starts a copy transition.
 *
 * ONE mechanism for all of them — start an experiment, enter a colleague's copy
 * or an experiment, switch back, merge back, discard — so a transition can
 * never half-render in one place because a component grew its own spinner.
 */
interface UiLock {
  /** Put the sheet up NOW, on the click frame. `target` is the copy that must
   *  become renderable, or null when the server still has to name it. */
  // eslint-disable-next-line no-restricted-syntax -- null = not named yet
  lock: (label: string, timeoutMs: number, target: string | null) => void;
  /** The server named the destination (a new experiment's slug). */
  target: (name: string) => void;
  /** The request is done; only the copies feed is still awaited. */
  settling: () => void;
  /** Take the sheet down now — the transition failed, or there is nothing
   *  left to wait for. The caller has already said why. */
  release: () => void;
}

// A local git clone plus a copies-feed round trip. Generous, because a first
// experiment on a big workspace really can take a while — but finite.
const BUSY_TIMEOUT_CREATE_MS = 5 * 60_000;
// Selecting a copy that already exists: at most a business process being
// materialized into it.
const BUSY_TIMEOUT_SWITCH_MS = 2 * 60_000;

function Shell() {
  const { processes } = useProcesses();
  const { copies: copiesSnapshot } = useCopies();
  const deployDone = useDeployDone();
  const { sendPrompt, startMergeBackSession } = useSessions();
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
  // The "take this version wholesale" confirmation, and what it is about.
  // null = closed. `source` is what the copy would become; `experiment` names
  // it when the version comes from one.
  const [takeVersion, setTakeVersion] = useState<{
    source: TakeVersionSource;
    bp: string;
    bpLabel: string;
    sourceLabel: string;
    experiment?: string;
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  } | null>(null);
  const [taking, setTaking] = useState(false);
  // Bumped on every editor save so copy-dirtiness consumers refetch (the
  // SSE snapshot only refreshes on git events, not file writes).
  const [copyEditNonce, setCopyEditNonce] = useState(0);
  // Bumped when one of the user's OWN git actions finishes (pull, merge-back)
  // so the behind-main check re-reads immediately instead of waiting for the
  // next event — that's what makes the Sync step disappear right after a pull.
  const [syncCheckNonce, setSyncCheckNonce] = useState(0);
  // The copy transition currently locking the interface. null = the app is
  // live. See `Busy` and `BusyOverlay`.
  // eslint-disable-next-line no-restricted-syntax -- null = not locked
  const [busy, setBusy] = useState<Busy | null>(null);

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
  // A copy we have just created (an experiment) and selected. The copies feed
  // has not delivered it yet, so the consistency effect below would otherwise
  // decide the selection names nothing and snap it back to the user's own
  // copy — leaving them outside the experiment they just started, and (since
  // the interface lock waits for exactly this copy to become renderable)
  // leaving the app locked until the timeout. Mirrors `justCreatedBpRef`.
  // eslint-disable-next-line no-restricted-syntax -- null = nothing just created
  const justCreatedCopyRef = useRef<string | null>(null);
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
    // Stop protecting a just-created copy once the feed actually carries it.
    if (
      justCreatedCopyRef.current &&
      available.some((w) => w.name === justCreatedCopyRef.current)
    )
      justCreatedCopyRef.current = null;
    setCopy((cur) => {
      // A selection on a mid-teardown copy must move off it now, not when the
      // snapshot finally drops it.
      const kept = cur && !deletedCopiesRef.current.has(cur) ? cur : null;
      if (
        kept &&
        (available.some((w) => w.name === kept) ||
          kept === myCopy ||
          kept === justCreatedCopyRef.current)
      )
        return kept;
      // Prefer the user's own copy (even before it appears in the snapshot, so
      // first-login selection sticks); otherwise fall back to the first copy.
      if (myCopy && !deletedCopiesRef.current.has(myCopy)) return myCopy;
      return available[0]?.name ?? null;
    });
  }, [copiesSnapshot, myCopy, myCopyResolved]);

  // Pull main's new commits into ONE BUSINESS PROCESS of a copy (rebase that
  // clone onto its own main). Scoped, like Deploy: each business process is
  // its own repository, so pulling one cannot touch another, and the user is
  // only told about — and only accepts — the process they are looking at. A
  // clean pull redeploys live-dev when its image dir changed; a conflict
  // can't be resolved automatically, so we route the user to the Coding Agent
  // to finish the rebase by hand.
  const handlePullBp = useCallback(
    async (copyName: string, bpDir: string, bpLabelForCopy: string) => {
      const id = `pull-copy-${copyName}-${bpDir}`;
      toast.loading(`Pulling main into ${bpLabelForCopy}…`, {
        id,
        duration: Infinity,
      });
      try {
        const res = await api.copyFiles.rebase(copyName, bpDir);
        if (res.status === 'noop') {
          toast.success(`${bpLabelForCopy} is already up to date with main`, {
            id,
            duration: 4000,
          });
          return;
        }
        if (res.status === 'needs_rebase') {
          toast.error(`${bpLabelForCopy}: ${res.message}`, { id, duration: 10000 });
          // Hand off to the Coding Agent on this copy to resolve the conflict.
          // HANDING OFF MEANS GIVING IT THE TASK. Opening the tab was all this
          // did, so the user arrived at an agent that had been told nothing,
          // sitting at an empty prompt, with no way to know that finishing a
          // rebase was now their job to describe — the merge-back path next to
          // it has always sent its prompt (`startMergeBackSession`). The sync
          // prompt is the conflict-resolution one: commit WIP, rebase onto
          // main, resolve, push.
          setCopy(copyName);
          await sendPrompt(copyName, bpDir, 'sync').catch((err: unknown) => {
            toast.error(
              `Failed to hand the rebase to the agent: ${errorMessage(err)}`,
            );
          });
          handleTab('agent');
          return;
        }
        toast.success(res.message, { id, duration: 6000 });
        (res.deploy_task_ids ?? []).forEach((tid: string, i: number) => {
          void watchDeployTask(tid, `${id}-deploy-${i}`, {
            loading: `Redeploying ${bpLabelForCopy}'s live-dev…`,
            success: `${bpLabelForCopy}'s live-dev updated`,
            failurePrefix: `Live-dev redeploy for ${bpLabelForCopy} failed`,
          });
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          // The app-wide re-login banner already prompts; don't pile on.
          toast.dismiss?.(id);
          return;
        }
        toast.error(
          `Failed to pull main into ${bpLabelForCopy}: ${errorMessage(err)}`,
          { id, duration: 8000 },
        );
      } finally {
        // This process's refs just moved (or provably didn't) — re-read the
        // divergence now so the Sync step goes away without waiting for the
        // next SSE event. Also correct on failure: the pull may have got
        // part-way.
        setSyncCheckNonce((n) => n + 1);
      }
    },
    [handleTab, sendPrompt],
  );

  const bp = useMemo(
    () => bps.find((b) => b.id === bpId) ?? null,
    [bps, bpId],
  );
  const wt = useMemo(
    () => (copy ? copies.find((w) => w.name === copy) ?? null : null),
    [copy, copies],
  );

  // ── the interface lock ────────────────────────────────────────────────────
  // Put the sheet up on the click frame, take it down when the destination is
  // fully renderable — never in between, and never on a timer.
  const lock = useCallback((label: string, timeoutMs: number, target: string | null) => {
    setBusy({ label, target, inFlight: true, startedAt: Date.now(), timeoutMs });
  }, []);
  /** The server has named the destination (a new experiment's slug). */
  const lockTarget = useCallback((target: string) => {
    setBusy((b) => (b ? { ...b, target } : b));
  }, []);
  /** The request finished; the lock now waits only on the copies feed. */
  const lockSettling = useCallback(() => {
    setBusy((b) => (b ? { ...b, inFlight: false } : b));
  }, []);
  /** The transition failed, or was never going to happen. The caller has
   *  already said why — this only takes the sheet down. */
  const unlock = useCallback(() => setBusy(null), []);
  const uiLock: UiLock = useMemo(
    () => ({ lock, target: lockTarget, settling: lockSettling, release: unlock }),
    [lock, lockTarget, lockSettling, unlock],
  );

  // The destination is renderable when it is BOTH selected and present in the
  // copies snapshot: `wt` is what the banner and the pipeline read, and a
  // selected copy the feed hasn't delivered yet renders as "no copy" — which is
  // the half-state the lock exists to hide.
  const busyDone =
    busy !== null &&
    !busy.inFlight &&
    busy.target !== null &&
    copy === busy.target &&
    copies.some((c) => c.name === busy.target);
  useEffect(() => {
    if (busyDone) setBusy(null);
  }, [busyDone]);

  // A destination that never arrives must not leave the app locked. Say what
  // did not happen and hand the interface back — loudly, because the user's
  // action may well have taken effect server-side and the app can no longer
  // tell them whether it did.
  useEffect(() => {
    if (!busy) return;
    const left = busy.startedAt + busy.timeoutMs - Date.now();
    const label = busy.label;
    const id = window.setTimeout(
      () => {
        setBusy(null);
        toast.error(`Gave up waiting: ${label}`, {
          id: 'copy-transition-timeout',
          description:
            `It did not finish within ${Math.round(busy.timeoutMs / 1000)}s. It may ` +
            `still be running on the server — reload to see where you actually are.`,
        });
      },
      Math.max(0, left),
    );
    return () => window.clearTimeout(id);
  }, [busy]);

  // The human name of the ONE business process an experiment is on, for the
  // banner. Resolved from `wt.bp` — the directory name gitops recorded — never
  // from the experiment's slug. Empty when there is no recorded process (a
  // legacy experiment) or the feed hasn't delivered the process yet; the banner
  // handles both by not naming one rather than by naming a guess.
  const bpLabel = useBpLabel();
  const experimentBpLabel = wt?.bp ? bpLabel(wt.bp) : '';

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

  // ── the ONE divergence reading ────────────────────────────────────────────
  // How the business process ON SCREEN stands against its OWN main. Read once,
  // here, and handed to everything that needs it — the Sync step's existence,
  // the Sync screen, and the Deploy screen's fast-forward gate — because they
  // are the same fact asked more than once and any second reading is a chance
  // for them to disagree. They did: the Sync step used to come off a COPY-WIDE
  // "behind" count while Deploy used this per-process one, and a user on a
  // process that was perfectly up to date got a Sync step offering a different
  // process's 21 commits.
  //
  // Read for whatever copy is in view (a colleague's Deploy screen shows their
  // divergence too); only the Sync STEP is restricted to the user's own copy,
  // since that is the only copy main is ever pulled into.
  const {
    divergence: bpDivergence,
    error: divergenceError,
    resolved: divergenceResolved,
    recheck: recheckDivergence,
  } = useBpDivergence(copy, bpId, syncCheckNonce + copyEditNonce);
  const behindBp = bpDivergence?.behind_bp ?? null;

  // OPENING one of the two screens that live off this reading re-takes it.
  // When each screen fetched for itself, navigating to it remounted the
  // component and refetched; lifting the read into the shell removed that, and
  // a stale "up to date" survived until the next git event — so a user who
  // merged an experiment back and then opened Deploy was told there was
  // nothing to publish. Asking again when the user asks to look is the honest
  // trigger, and the hook coalesces, so it costs at most one request.
  useEffect(() => {
    if (tab === 'deploy' || tab === 'sync') recheckDivergence();
  }, [tab, recheckDivergence]);

  // Fail loudly. The Sync step's existence hangs off this count, so a read we
  // couldn't make is said out loud and the step is OFFERED anyway: hiding the
  // only route to a pull because we don't know is the silent fallback this
  // whole change removes. Opening Sync then shows the live reading, which is
  // authoritative either way.
  const syncVisible =
    isMyCopy && (divergenceError !== null || (behindBp !== null && behindBp > 0));

  // One notification, updated in place by id — a persistent failure re-checked
  // on every git event must not become a wall of identical rows, and a
  // recovery must retract the warning instead of leaving it standing. It names
  // the BUSINESS PROCESS, because that is what the reading is about.
  const behindErrorReportedRef = useRef(false);
  const bpLabelText = bp?.displayName ?? bp?.name ?? '';
  useEffect(() => {
    if (!isMyCopy) return;
    if (divergenceError !== null) {
      behindErrorReportedRef.current = true;
      toast.error(
        `Couldn't read whether main has changes ${bpLabelText || 'this business process'} ` +
          `hasn't pulled yet: ${divergenceError}`,
        {
          id: 'copy-behind-check',
          description:
            'The Sync step stays available while this is unknown — open it to ' +
            'see the live reading, or reload once gitops is reachable.',
        },
      );
      return;
    }
    if (behindErrorReportedRef.current && behindBp !== null) {
      behindErrorReportedRef.current = false;
      toast.success('Sync status is readable again', {
        id: 'copy-behind-check',
        description:
          behindBp > 0
            ? `Main has ${behindBp} change(s) ${bpLabelText} hasn't pulled yet.`
            : `${bpLabelText} has everything on main.`,
      });
    }
  }, [divergenceError, behindBp, isMyCopy, bpLabelText]);

  // Leaving a tab stranded is worse than moving the user: when the Sync step
  // disappears (pulled, switched to a business process that is up to date, or
  // switched to someone else's copy), or Deploy does (entered an experiment),
  // fall back to Description.
  // ...but not before we know: on a reload the tab is restored from the URL
  // while the divergence read is still in flight, and evicting the user from a
  // step that does exist makes the shared link look broken. On someone else's
  // copy there is nothing to wait for — the step can't exist there at all.
  const behindResolved = !isMyCopy || divergenceResolved;
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
    // Merging ends the experiment and moves the user to another copy, so the
    // interface is locked for the whole thing: the merge, the discard and the
    // landing all have to happen before the chrome is correct again.
    lock(`Merging “${label}” back into your copy…`, BUSY_TIMEOUT_CREATE_MS, parent);
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
      lockSettling();
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
        // The experiment survives and the user stays in it, so there is no
        // transition left to wait for — hand the interface back.
        unlock();
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
      // Nothing moved — take the sheet down and let the error speak.
      unlock();
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
  }, [
    wt,
    merging,
    bpId,
    startMergeBackSession,
    handleTab,
    handleCopyDeleted,
    lock,
    lockSettling,
    unlock,
  ]);

  // ── take a version wholesale ──────────────────────────────────────────────
  // The fourth thing that can happen to an experiment (merge it, discard it,
  // leave it running — or take it), and the escape hatch from the Sync step
  // ("edit the main version without merging my changes"). Both are the same
  // gitops primitive: park what my copy has for this ONE business process as
  // an experiment of its own, then make my copy the chosen version.
  //
  // Taking an EXPERIMENT is a copy transition — the experiment is consumed and
  // the user lands back on their own copy — so it locks the interface like
  // every other one. Taking MAIN happens where the user already is, so it does
  // not.
  const runTakeVersion = useCallback(async () => {
    const req = takeVersion;
    if (!req || !myCopy || taking) return;
    const { source, bp: bpDir, bpLabel: label, sourceLabel, experiment } = req;
    const id = `take-version-${bpDir}`;
    const moving = source === 'experiment';
    setTaking(true);
    if (moving) {
      lock(`Taking “${sourceLabel}” into your copy…`, BUSY_TIMEOUT_CREATE_MS, myCopy);
    }
    toast.loading(
      moving
        ? `Taking “${sourceLabel}” into your copy…`
        : `Taking the main version of ${label}…`,
      { id, duration: Infinity },
    );
    try {
      const res = await api.copyFiles.adopt(myCopy, {
        bp: bpDir,
        source,
        bpLabel: label,
        ...(experiment ? { experiment } : {}),
      });
      setTakeVersion(null);
      if (moving) {
        // Land on the copy first — the work is there now — and only then
        // tombstone the consumed experiment so the selection cannot drift back
        // onto a copy that is mid-teardown while the feed still lists it.
        setCopy(myCopy);
        lockSettling();
        if (experiment) handleCopyDeleted(experiment);
      }
      toast.success(res.message, { id, duration: 8000 });
      // Parking is silent by design when there was nothing to park; when there
      // WAS, the user needs to know where it went, by the name they will see.
      if (res.parked) {
        toast.info(`Your previous work is saved as “${res.parked.title}”`, {
          description: 'Open it again under Advanced → Experiments.',
          duration: 10000,
        });
      }
      (res.deploy_task_ids ?? []).forEach((tid, i) => {
        void watchDeployTask(tid, `${id}-deploy-${i}`, {
          loading: `Redeploying your copy's live-dev…`,
          success: `Your copy's live-dev updated`,
          failurePrefix: `Live-dev redeploy failed`,
        });
      });
    } catch (err) {
      // Nothing moved, or the parked work is named in the error itself — take
      // the sheet down and let the message speak.
      if (moving) unlock();
      if (err instanceof SessionExpiredError) {
        toast.dismiss?.(id);
        return;
      }
      toast.error(`Couldn't take that version: ${errorMessage(err)}`, {
        id,
        duration: 12000,
      });
    } finally {
      setTaking(false);
      setSyncCheckNonce((n) => n + 1);
    }
  }, [
    takeVersion,
    myCopy,
    taking,
    lock,
    lockSettling,
    unlock,
    handleCopyDeleted,
  ]);

  // Discarding an experiment is a real delete (branch, checkout, live-dev
  // containers), so it goes through the same warn+confirm dialog as any other
  // copy delete; handleCopyDeleted then moves the selection back to my copy.
  const handleDiscardExperiment = useCallback(() => {
    if (wt) setDiscardTarget(wt);
  }, [wt]);

  // Start an experiment. The SHELL owns this rather than the dialog, because
  // what it really is is a copy transition: the dialog closes on submit, the
  // interface locks, and it unlocks on the far side — in the experiment, with
  // the banner and the pipeline already correct. Done from the dialog it could
  // only ever hand back a half-updated app and a toast.
  const handleStartExperiment = useCallback(
    (title: string, onBp: BusinessProcess) => {
      uiLock.lock(
        `Starting experiment “${title}” on ${onBp.displayName}…`,
        BUSY_TIMEOUT_CREATE_MS,
        null, // gitops generates the slug; `uiLock.target` fills it in below
      );
      const id = `create-experiment-${title}`;
      toast.loading(`Starting experiment “${title}” on ${onBp.displayName}…`, {
        id,
        duration: Infinity,
      });
      void api
        .createExperiment({ title, bp: onBp.name })
        .then((res) => {
          toast.success(`Experiment “${title}” created`, { id, duration: 6000 });
          // Selecting it is not enough to lift the lock: the copies feed still
          // has to deliver it before the banner can render. `target` is what
          // the lock waits on.
          uiLock.target(res.name);
          justCreatedCopyRef.current = res.name;
          setCopy(res.name);
          uiLock.settling();
          // An experiment deploys nothing up front — the business process the
          // user opens is brought up lazily on access. These branches only fire
          // if gitops ever does spawn a deploy here.
          if (res.deploy_error) {
            toast.error(
              `Failed to start automations in “${title}”: ${res.deploy_error}`,
            );
          } else if (res.deploy_task_id) {
            void watchDeployTask(res.deploy_task_id, `exp-deploy-${res.name}`, {
              loading: `Starting automations in “${title}”…`,
              success: `Experiment “${title}” automations started`,
              failurePrefix: `Failed to start automations in “${title}”`,
            });
          }
        })
        .catch((err: unknown) => {
          // Nothing was created, or we cannot tell — hand the interface back
          // and say so with the server's own words, which name the fix.
          uiLock.release();
          if (err instanceof SessionExpiredError) {
            toast.dismiss?.(id);
            return;
          }
          toast.error(`Failed to start experiment: ${errorMessage(err)}`, {
            id,
            duration: 10000,
          });
        });
    },
    [uiLock],
  );

  // Move to another copy — a colleague's, one of your experiments, or back to
  // your own. The destination already exists, so the only thing the lock waits
  // for is any business process being materialized into it on the way.
  const handleEnterCopy = useCallback(
    (name: string, label: string, after?: () => Promise<void>) => {
      if (name === copy && !after) return;
      uiLock.lock(label, BUSY_TIMEOUT_SWITCH_MS, name);
      setCopy(name);
      if (!after) {
        uiLock.settling();
        return;
      }
      // Work that has to finish before the destination is usable — a business
      // process being cloned into it. It reports its own failures; the lock
      // only cares that it is over.
      void after().finally(() => uiLock.settling());
    },
    [copy, uiLock],
  );

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
        onEnterCopy={handleEnterCopy}
        onStartExperiment={handleStartExperiment}
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
          {...(myCopy
            ? {
                onSwitchBack: () =>
                  handleEnterCopy(myCopy, 'Switching back to your copy…'),
              }
            : {})}
        />
      )}
      {wt && isMyExperiment && (
        <ExperimentBanner
          copy={wt}
          bpLabel={experimentBpLabel}
          {...(wt.parent
            ? {
                // Purely navigation: the same locked copy transition the
                // colleague banner's "Switch back to my copy" uses. Nothing is
                // asked of gitops and nothing about the experiment changes —
                // it is still there, under Advanced → Experiments.
                onLeave: () =>
                  handleEnterCopy(
                    wt.parent as string,
                    'Switching back to your copy…',
                  ),
              }
            : { onLeave: () => undefined })}
          merging={merging}
          refreshKey={copyEditNonce}
          onMergeBack={() => void handleMergeBack()}
          onDiscard={handleDiscardExperiment}
          onUseThisVersion={() =>
            wt.bp &&
            setTakeVersion({
              source: 'experiment',
              bp: wt.bp,
              bpLabel: experimentBpLabel || wt.bp,
              sourceLabel: wt.title ?? wt.name,
              experiment: wt.name,
            })
          }
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
          divergence={bpDivergence}
          divergenceError={divergenceError}
          onPullBp={handlePullBp}
          onMergeBack={() => void handleMergeBack()}
          {...(isMyCopy && bp
            ? {
                // "Edit the main version without merging my changes" — the
                // other way past a Sync step, offered where the Sync step is.
                onTakeMain: () =>
                  setTakeVersion({
                    source: 'main',
                    bp: bp.name,
                    bpLabel: bp.displayName,
                    sourceLabel: 'main',
                  }),
              }
            : {})}
        />
      )}
      {/* Taking a version wholesale, from an experiment or from main. The
          dialog's whole job is the promise that what you have is kept. */}
      <TakeVersionDialog
        open={takeVersion !== null}
        source={takeVersion?.source ?? 'main'}
        bpLabel={takeVersion?.bpLabel ?? ''}
        {...(takeVersion?.sourceLabel ? { sourceLabel: takeVersion.sourceLabel } : {})}
        busy={taking}
        onConfirm={() => void runTakeVersion()}
        onCancel={() => !taking && setTakeVersion(null)}
      />
      {/* Discarding an experiment: the same warn+confirm delete dialog every
          copy delete goes through — it names the unmerged and uncommitted work
          the discard would destroy. */}
      <DeleteCopyDialog
        copy={discardTarget}
        isOwnCopy={false}
        onClose={() => setDiscardTarget(null)}
        onDeleted={handleCopyDeleted}
        {...(myCopy
          ? {
              // Discarding is a copy transition too: it ends where the user is
              // and puts them back on their own copy, so the interface locks
              // from the confirm click until that copy is what renders.
              onConfirmed: (label: string) =>
                uiLock.lock(
                  `Discarding “${label}”…`,
                  BUSY_TIMEOUT_SWITCH_MS,
                  myCopy,
                ),
              onSettled: uiLock.settling,
              onFailed: uiLock.release,
            }
          : {})}
      />
      {/* The single activity surface, anchored bottom-left: server-side git
          tasks AND transient notifications (former toasts) in one collapsible
          panel. */}
      <TaskQueuePanel />
      {/* Last in the tree and fixed: the whole app, including the dialogs and
          the activity panel, is behind it while a copy transition settles. */}
      {busy && <BusyOverlay label={busy.label} />}
    </div>
  );
}
