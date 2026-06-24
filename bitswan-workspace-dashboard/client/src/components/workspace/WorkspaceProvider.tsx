import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { BusinessProcess, DeployedAutomation, Copy } from '@/types';

export type StreamStatus = 'connecting' | 'live' | 'error';

interface WorkspaceContextValue {
  /** Latest automations snapshot from the upstream SSE feed. */
  automations: DeployedAutomation[];
  /** Latest business-process listing (main repo + all copies, deduped). */
  // eslint-disable-next-line no-restricted-syntax -- nullable until first delivery
  processes: BusinessProcess[] | null;
  /** Latest copy listing — same payload as the old `/api/copies` REST. */
  // eslint-disable-next-line no-restricted-syntax -- nullable until first delivery
  copies: Copy[] | null;
  /** Live status of the SSE subscription. */
  status: StreamStatus;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Wire shape of one entry in gitops's `processes` event. */
interface GitopsProcessEntry {
  id: string;
  name: string;
  in_main: boolean;
  copies: string[];
  has_copies: boolean;
}

function toBusinessProcess(p: GitopsProcessEntry): BusinessProcess {
  return {
    id: p.name,
    name: p.name,
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
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    const es = new EventSource('/api/events', { withCredentials: true });

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

    es.addEventListener('automations', (ev) => {
      handleAutomationsPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('processes', (ev) => {
      handleProcessesPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('copies', (ev) => {
      handleCopiesPayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('open', () => setStatus('live'));
    es.addEventListener('error', () => setStatus('error'));

    return () => es.close();
  }, []);

  return (
    <WorkspaceContext.Provider value={{ automations, processes, copies, status }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
/* eslint-enable no-restricted-syntax */

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
