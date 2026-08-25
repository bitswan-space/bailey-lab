import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/api';
import type {
  BusinessProcess,
  DeployedAutomation,
  Copy,
  GitTask,
} from '@/types';

export type StreamStatus = 'connecting' | 'live' | 'error';

/** A deploy task still running somewhere in the workspace (SSE
 *  `deploy_progress` before its terminal event). */
export interface ActiveDeploy {
  taskId: string;
  /** BP-level tasks name the BP; single-automation tasks leave it null (their
   *  `deploymentId` still embeds the BP name). */
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable
  bp: string | null;
  deploymentId: string;
  /** Member deployment ids of a BP-level task (empty for single-automation
   *  tasks) — their `-dev`/`-staging` suffix is how views infer the stage. */
  members: string[];
  /** Latest progress line ("Building images…", "2/4 deployed…"). */
  message: string;
  current: number;
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable
  total: number | null;
}

interface WorkspaceContextValue {
  /** Latest automations snapshot from the upstream SSE feed. */
  automations: DeployedAutomation[];
  /** Latest business-process listing (main repo + all copies, deduped). */
  // eslint-disable-next-line no-restricted-syntax -- nullable until first delivery
  processes: BusinessProcess[] | null;
  /** Latest copy listing — same payload as the old `/api/copies` REST. */
  // eslint-disable-next-line no-restricted-syntax -- nullable until first delivery
  copies: Copy[] | null;
  /** Git task queue (newest first). `null` until the first delivery so the UI
   *  can tell "loading" from "empty". */
  // eslint-disable-next-line no-restricted-syntax -- nullable until first delivery
  tasks: GitTask[] | null;
  /** Monotonic counter bumped each time a supply-chain scan finishes (SSE
   *  `supply_chain` event). The Supply Chain Security / Supply chain panel watches it to
   *  refresh itself the moment results exist — no manual "check back". */
  supplyChainTick: number;
  /** Last deploy task that reached a terminal state (SSE `deploy_progress`
   *  with status completed/failed), whoever started it — another tab, another
   *  user, the API. Views showing deploy-derived data (stage history) watch
   *  `seq` and refetch when their BP matches; `bp` is null for
   *  single-automation deploys, whose `deploymentId` still names the BP. */
  // eslint-disable-next-line no-restricted-syntax -- null until a deploy finishes
  deployDone: { seq: number; bp: string | null; deploymentId: string } | null;
  /** Bumped whenever an action of OURS has moved a copy's git refs — a pull, a
   *  merge-back, a version taken wholesale, a dev revert. The `copies` SSE
   *  snapshot eventually says the same thing, but "eventually" is the bug: a
   *  user who takes a version and immediately opens Deploy was told their copy
   *  was up to date, because the divergence on screen was the one read before
   *  the action. Any component that moves refs bumps this on completion, and
   *  every reading derived from refs watches it.
   *
   *  It is shared state rather than a prop because the sites that move refs are
   *  not all in the shell — the hotpatch and the dev revert live inside the
   *  Deployments tab's inspect modal, which has no channel back to it. */
  copyRefsMoved: number;
  /** Say that one just happened. */
  notifyCopyRefsMoved: () => void;
  /** Deploys currently in flight (upserted per `deploy_progress` event,
   *  dropped on the terminal one) — lets views render a live "deploying"
   *  placeholder for work started outside them. */
  activeDeploys: ActiveDeploy[];
  /** Live status of the SSE subscription. */
  status: StreamStatus;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Wire shape of one entry in gitops's `processes` event. */
interface GitopsProcessEntry {
  id: string;
  name: string;
  display_name?: string;
  in_main: boolean;
  copies: string[];
  has_copies: boolean;
}

function toBusinessProcess(p: GitopsProcessEntry): BusinessProcess {
  return {
    id: p.name,
    name: p.name,
    displayName: p.display_name || p.name,
    path: p.name,
    inMain: p.in_main,
    copies: p.copies,
    hasCopies: p.has_copies,
  };
}

/**
 * Holds the single `/api/events` SSE subscription for the whole app. Views
 * mount and unmount as the user switches scopes (Deployments / Copy /
 * Agents), but the EventSource — and the cached snapshots — survive,
 * eliminating the "Loading…" flash on every tab switch.
 *
 * Tracks both `automations` (Docker state) and `processes` (workspace BP
 * list, maintained by gitops's filesystem watchers). The dashboard no
 * longer polls for BPs — updates flow in over the SSE feed.
 */
/* eslint-disable no-restricted-syntax -- this whole component sits at the
   SSE-feed boundary: nullable wire types until the first delivery, JSON-parse
   boundaries, and EventSource named-event dispatch (which the DOM types
   model as `Event`, not `MessageEvent`). All `as` / `null` usage below is
   intentional. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [automations, setAutomations] = useState<DeployedAutomation[]>([]);
  const [processes, setProcesses] = useState<BusinessProcess[] | null>(null);
  const [copies, setCopies] = useState<Copy[] | null>(null);
  const [tasks, setTasks] = useState<GitTask[] | null>(null);
  const [supplyChainTick, setSupplyChainTick] = useState(0);
  const [deployDone, setDeployDone] = useState<
    { seq: number; bp: string | null; deploymentId: string } | null
  >(null);
  const [activeDeploys, setActiveDeploys] = useState<ActiveDeploy[]>([]);
  const [copyRefsMoved, setCopyRefsMoved] = useState(0);
  const notifyCopyRefsMoved = useCallback(() => setCopyRefsMoved((n) => n + 1), []);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  // Initial git-task-queue snapshot on mount. The server replays the latest
  // `task_queue_snapshot` over SSE on connect, but a one-shot REST fetch
  // guarantees the queue is populated even if no snapshot has flowed yet
  // (e.g. gitops restarted after the dashboard's stream opened).
  useEffect(() => {
    let cancelled = false;
    api
      .tasks()
      .then((res) => {
        if (cancelled) return;
        // MERGE with whatever the SSE feed delivered first, live entries
        // winning on id collisions. Discarding the REST result whenever any
        // snapshot beat it to the punch loses the queue on page reload: the
        // replayed snapshot can be stale/empty while this fetch has the real
        // queue.
        setTasks((cur) => {
          if (!cur || cur.length === 0) return res.tasks;
          const byId = new Map(res.tasks.map((t) => [t.task_id, t]));
          for (const t of cur) byId.set(t.task_id, t);
          return Array.from(byId.values());
        });
      })
      .catch(() => {
        // gitops down / not configured — leave null so the panel stays in its
        // loading state until the SSE feed delivers (or never shows).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // The EventSource is created inside `connect()` (bottom of this effect) so
    // it can be RECREATED: the browser retries dropped connections itself, but
    // an HTTP-error response — e.g. the gate answering 502 while the dashboard
    // server restarts — closes the stream permanently, and without manual
    // reconnection the page silently stops receiving live updates until a
    // full reload.
    let es: EventSource | null = null;
    let retryTimer: number | null = null;
    let disposed = false;
    let attempt = 0;
    let everOpened = false;

    const handleAutomationsPayload = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        if (Array.isArray(payload)) setAutomations(payload as DeployedAutomation[]);
      } catch {
        // ignore non-JSON event data
      }
    };

    const handleProcessesPayload = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        if (!Array.isArray(payload)) return;
        setProcesses((payload as GitopsProcessEntry[]).map(toBusinessProcess));
      } catch {
        // ignore
      }
    };

    const handleCopiesPayload = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        // Older gitops emitted an empty object `{}` as a ping; treat that
        // and any non-array payload as "no data, keep current state".
        if (!Array.isArray(payload)) return;
        setCopies(payload as Copy[]);
      } catch {
        // ignore
      }
    };

    // Git task queue: full-array snapshot on connect, single-task upsert per
    // change (keyed by task_id; gitops sends newest first, which we preserve
    // by replacing in place / prepending new ones).
    const handleTaskSnapshot = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        if (!Array.isArray(payload)) return;
        const snap = payload as GitTask[];
        // MERGE, don't replace. The panel is a full session log, but gitops's
        // task queue is in-memory: it trims finished tasks (keeps the last N)
        // and resets entirely on a gitops restart. A naive replace would drop
        // tasks we already showed every time a smaller/empty snapshot arrives
        // (SSE reconnect, restart) — they'd appear then vanish. Merging by id
        // updates known tasks and adds new ones while keeping the history.
        setTasks((cur) => {
          if (!cur || cur.length === 0) return snap;
          const byId = new Map(cur.map((t) => [t.task_id, t]));
          for (const t of snap) byId.set(t.task_id, t);
          return Array.from(byId.values());
        });
      } catch {
        // ignore non-JSON event data
      }
    };
    const handleTaskUpsert = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object') return;
        const task = payload as GitTask;
        if (!task.task_id) return;
        setTasks((cur) => {
          const list = cur ?? [];
          const idx = list.findIndex((t) => t.task_id === task.task_id);
          if (idx === -1) return [task, ...list];
          const next = list.slice();
          next[idx] = task;
          return next;
        });
      } catch {
        // ignore
      }
    };

    const connect = () => {
      if (disposed) return;
      const src = new EventSource('/api/events', { withCredentials: true });
      es = src;

      src.addEventListener('task_queue_snapshot', (ev) => {
      handleTaskSnapshot((ev as MessageEvent).data);
      setStatus('live');
    });
    src.addEventListener('task_queue', (ev) => {
      handleTaskUpsert((ev as MessageEvent).data);
      setStatus('live');
    });
    src.addEventListener('automations', (ev) => {
      handleAutomationsPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    src.addEventListener('processes', (ev) => {
      handleProcessesPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    src.addEventListener('copies', (ev) => {
      handleCopiesPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    src.addEventListener('deploy_progress', (ev) => {
      // Non-terminal events keep `activeDeploys` current so views can render
      // a live "deploying" placeholder; the terminal one (completed/failed)
      // means the deploy repo / bitswan.yaml changed, so deploy-derived views
      // (stage history) refetch via `deployDone`. The initiator's own toast
      // still runs off the deploy-status poll (see deployBp.ts on why
      // polling, not this event, drives it).
      try {
        const t = JSON.parse((ev as MessageEvent).data);
        if (!t || typeof t !== 'object' || typeof t.task_id !== 'string') return;
        if (t.status === 'completed' || t.status === 'failed') {
          setActiveDeploys((cur) => cur.filter((d) => d.taskId !== t.task_id));
          setDeployDone((cur) => ({
            seq: (cur?.seq ?? 0) + 1,
            bp: typeof t.bp === 'string' ? t.bp : null,
            deploymentId: typeof t.deployment_id === 'string' ? t.deployment_id : '',
          }));
        } else {
          const next: ActiveDeploy = {
            taskId: t.task_id,
            bp: typeof t.bp === 'string' ? t.bp : null,
            deploymentId: typeof t.deployment_id === 'string' ? t.deployment_id : '',
            members: Array.isArray(t.members)
              ? t.members.filter((m: unknown): m is string => typeof m === 'string')
              : [],
            message: typeof t.message === 'string' ? t.message : '',
            current: typeof t.current === 'number' ? t.current : 0,
            total: typeof t.total === 'number' ? t.total : null,
          };
          setActiveDeploys((cur) => {
            const idx = cur.findIndex((d) => d.taskId === next.taskId);
            if (idx === -1) return [...cur, next];
            const copy = cur.slice();
            copy[idx] = next;
            return copy;
          });
        }
      } catch {
        // ignore non-JSON event data
      }
      setStatus('live');
    });
    src.addEventListener('supply_chain', () => {
      // A scan finished — bump the counter so any open Supply Chain Security / Supply chain
      // panel refetches and shows the result without a manual refresh.
      setSupplyChainTick((n) => n + 1);
      setStatus('live');
    });
      src.addEventListener('open', () => {
        attempt = 0;
        if (everOpened) {
          // A true RE-connect: terminal deploy events may have been missed
          // while the stream was down. The replay that follows this `open`
          // re-delivers the genuinely-active deploys, so drop the stale set;
          // bump `deployDone` with no target so deploy-derived views refetch.
          setActiveDeploys([]);
          setDeployDone((cur) => ({
            seq: (cur?.seq ?? 0) + 1,
            bp: null,
            deploymentId: '',
          }));
        }
        everOpened = true;
        setStatus('live');
      });
      src.addEventListener('error', () => {
        setStatus('error');
        // CONNECTING = the browser is retrying by itself; leave it alone.
        // CLOSED = permanent failure (non-200 response, e.g. a 502 during a
        // dashboard-server restart) — recreate the stream with backoff.
        if (src.readyState === EventSource.CLOSED) {
          attempt += 1;
          const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
          retryTimer = window.setTimeout(connect, delay);
        }
      });
    };
    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        automations,
        processes,
        copies,
        tasks,
        supplyChainTick,
        deployDone,
        copyRefsMoved,
        notifyCopyRefsMoved,
        activeDeploys,
        status,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
/* eslint-enable no-restricted-syntax */

/**
 * The counter that says "one of our own actions just moved a copy's refs", and
 * the function that bumps it. Everything derived from refs — how a business
 * process stands against main, what is uncommitted in a copy — re-reads on it,
 * so an action's result is on screen when the user looks rather than whenever
 * the next git event happens to arrive.
 */
export function useCopyRefsMoved(): {
  copyRefsMoved: number;
  notifyCopyRefsMoved: () => void;
} {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useCopyRefsMoved must be used inside <WorkspaceProvider>');
  return { copyRefsMoved: v.copyRefsMoved, notifyCopyRefsMoved: v.notifyCopyRefsMoved };
}

/** Read the shared automations snapshot. Must be used inside `<WorkspaceProvider>`. */
export function useAutomations(): {
  automations: DeployedAutomation[];
  status: StreamStatus;
} {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useAutomations must be used inside <WorkspaceProvider>');
  return { automations: v.automations, status: v.status };
}

/**
 * Read the shared BP snapshot. Returns `null` until the first SSE delivery
 * lands so callers can distinguish "still loading" from "no BPs".
 */
export function useProcesses(): {
  // eslint-disable-next-line no-restricted-syntax -- null = first SSE not yet received
  processes: BusinessProcess[] | null;
  status: StreamStatus;
} {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useProcesses must be used inside <WorkspaceProvider>');
  return { processes: v.processes, status: v.status };
}

/**
 * Read the shared copy list. Returns `null` until the first SSE delivery
 * lands so callers can show a loading state if needed.
 */
export function useCopies(): {
  // eslint-disable-next-line no-restricted-syntax -- null = first SSE not yet received
  copies: Copy[] | null;
  status: StreamStatus;
} {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useCopies must be used inside <WorkspaceProvider>');
  return { copies: v.copies, status: v.status };
}

/**
 * Read the shared git-task-queue snapshot. Returns `null` until the first
 * delivery (SSE or the mount REST fetch) so callers can distinguish "still
 * loading" from "empty queue".
 */
export function useTaskQueue(): {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing delivered yet
  tasks: GitTask[] | null;
  status: StreamStatus;
} {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useTaskQueue must be used inside <WorkspaceProvider>');
  return { tasks: v.tasks, status: v.status };
}

/**
 * A counter that increments whenever a supply-chain scan finishes (SSE
 * `supply_chain` event). Components showing scan results re-fetch when it
 * changes, so a pending scan resolves on screen with no manual refresh.
 */
export function useSupplyChainTick(): number {
  const v = useContext(WorkspaceContext);
  if (!v)
    throw new Error('useSupplyChainTick must be used inside <WorkspaceProvider>');
  return v.supplyChainTick;
}

/**
 * The last deploy task that finished (completed OR failed), regardless of who
 * started it. Views showing deploy-derived data watch `seq` and refetch when
 * the BP concerns them — this is what keeps the Deployments tab live for
 * deploys initiated outside it (Deploy, another tab, the API). Returns
 * `null` until a deploy finishes during this session.
 */
// eslint-disable-next-line no-restricted-syntax -- null until a deploy finishes
export function useDeployDone(): { seq: number; bp: string | null; deploymentId: string } | null {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useDeployDone must be used inside <WorkspaceProvider>');
  return v.deployDone;
}

/**
 * Deploys currently in flight anywhere in the workspace — one entry per live
 * `deploy_progress` task, dropped when its terminal event arrives. Views use
 * it to render a live "deploying" placeholder for work started outside them.
 * Best-effort: a dropped SSE stream at the wrong moment can lose an entry (or
 * its removal) until the next event or a page reload.
 */
export function useActiveDeploys(): ActiveDeploy[] {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useActiveDeploys must be used inside <WorkspaceProvider>');
  return v.activeDeploys;
}
