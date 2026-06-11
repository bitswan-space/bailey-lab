import { useCallback, useState } from 'react';
import { Play, RotateCw, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { AutomationState } from '@/types';

type Action = 'start' | 'stop' | 'restart';

const RUNNING_STATES = new Set(['running', 'starting', 'created', 'restarting', 'paused']);
const STOPPED_STATES = new Set(['exited', 'dead', 'paused']);

const ACTION_LABELS: Record<Action, { progress: string; done: string }> = {
  start: { progress: 'Starting', done: 'started' },
  stop: { progress: 'Stopping', done: 'stopped' },
  restart: { progress: 'Restarting', done: 'restarted' },
};

// eslint-disable-next-line no-restricted-syntax -- catch parameter is genuinely unknown
function isTransientFetchFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return /failed to fetch|networkerror/i.test(err.message);
}

interface ActionButtonsProps {
  deploymentId: string | null;
  state: AutomationState | null;
  automationName: string;
}

export function ActionButtons({ deploymentId, state, automationName }: ActionButtonsProps) {
  const [inFlight, setInFlight] = useState<Action | null>(null);

  const isRunning = state ? RUNNING_STATES.has(state) : false;
  const isStopped = state ? STOPPED_STATES.has(state) : false;
  const disabled = !deploymentId;

  const run = useCallback(
    async (action: Action) => {
      if (!deploymentId) return;
      setInFlight(action);
      const labels = ACTION_LABELS[action];
      // `toast.promise` shows a single toast that transitions from
      // loading → success → error in place. Network errors that the
      // postEmpty retry can't recover from are surfaced; transient
      // ERR_NETWORK_CHANGED on the second attempt is swallowed because
      // the upstream action almost always succeeded and the SSE feed
      // delivers the real state.
      const work = (async () => {
        if (action === 'start') await api.startAutomation(deploymentId);
        else if (action === 'stop') await api.stopAutomation(deploymentId);
        else await api.restartAutomation(deploymentId);
      })();
      toast.promise(work, {
        loading: `${labels.progress} ${automationName}…`,
        success: `${automationName} ${labels.done}`,
        error: (err: unknown) =>
          isTransientFetchFailure(err)
            ? `${automationName} ${labels.done}`
            : `Failed to ${action} ${automationName}: ${String(err)}`,
      });
      try {
        await work;
      } catch {
        // Already reported via toast.promise.
      } finally {
        setInFlight(null);
      }
    },
    [deploymentId, automationName],
  );

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('start')}
        disabled={disabled || inFlight !== null || isRunning}
      >
        <Play />
        Start
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('stop')}
        disabled={disabled || inFlight !== null || isStopped || !isRunning}
      >
        <Square />
        Stop
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('restart')}
        disabled={disabled || inFlight !== null || !isRunning}
      >
        <RotateCw className={cn(inFlight === 'restart' && 'animate-spin')} />
        Restart
      </Button>
    </div>
  );
}
