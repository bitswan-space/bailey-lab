import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { DeployedAutomation } from '@/types';

export type StreamStatus = 'connecting' | 'live' | 'error';

interface WorkspaceContextValue {
  /** Latest automations snapshot from the upstream SSE feed. */
  automations: DeployedAutomation[];
  /** Live status of the SSE subscription. */
  status: StreamStatus;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Holds the single `/api/events` SSE subscription for the whole app. Views
 * mount and unmount as the user switches scopes (Deployments / Worktree /
 * Agents), but the EventSource — and the cached snapshot — survives,
 * eliminating the "Loading…" flash on every tab switch.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // eslint-disable-next-line no-restricted-syntax -- DeployedAutomation is the live wire shape; see types/automation.ts
  const [automations, setAutomations] = useState<DeployedAutomation[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    const es = new EventSource('/api/events', { withCredentials: true });

    const handlePayload = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        // eslint-disable-next-line no-restricted-syntax -- JSON boundary; runtime-checked with Array.isArray
        if (Array.isArray(payload)) setAutomations(payload as DeployedAutomation[]);
      } catch {
        // ignore non-JSON event data
      }
    };

    // eslint-disable-next-line no-restricted-syntax -- EventSource named events lack typed dispatch
    es.addEventListener('snapshot', (ev) => {
      handlePayload((ev as MessageEvent).data);
      setStatus('live');
    });
    // eslint-disable-next-line no-restricted-syntax -- same
    es.addEventListener('automations', (ev) => {
      handlePayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('open', () => setStatus('live'));
    es.addEventListener('error', () => setStatus('error'));

    return () => es.close();
  }, []);

  return (
    <WorkspaceContext.Provider value={{ automations, status }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

/** Read the shared automations snapshot. Must be used inside `<WorkspaceProvider>`. */
export function useAutomations(): WorkspaceContextValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useAutomations must be used inside <WorkspaceProvider>');
  return v;
}
