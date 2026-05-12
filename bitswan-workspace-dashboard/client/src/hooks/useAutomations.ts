import { useEffect, useState } from 'react';
import type { DeployedAutomation } from '@/types';

export type StreamStatus = 'connecting' | 'live' | 'error';

/**
 * Subscribe to the live `/api/events` SSE feed of automation state. Returns
 * the latest snapshot plus a connection-status flag. Mounts a single
 * `EventSource` per consumer and tears it down on unmount.
 */
export function useAutomations(): {
  data: DeployedAutomation[];
  status: StreamStatus;
} {
  const [data, setData] = useState<DeployedAutomation[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    const es = new EventSource('/api/events', { withCredentials: true });

    const handlePayload = (raw: string) => {
      try {
        const payload = JSON.parse(raw);
        if (Array.isArray(payload)) setData(payload as DeployedAutomation[]);
      } catch {
        // ignore non-JSON event data
      }
    };

    es.addEventListener('snapshot', (ev) => {
      handlePayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('automations', (ev) => {
      handlePayload((ev as MessageEvent).data);
      setStatus('live');
    });
    es.addEventListener('open', () => setStatus('live'));
    es.addEventListener('error', () => {
      setStatus('error');
    });

    return () => {
      es.close();
    };
  }, []);

  return { data, status };
}
