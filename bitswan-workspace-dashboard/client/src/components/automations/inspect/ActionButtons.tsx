import { useCallback, useState } from 'react';
import { Play, RotateCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { AutomationState } from '@/types';

const RUNNING_STATES = new Set(['running', 'starting', 'created', 'restarting', 'paused']);
const STOPPED_STATES = new Set(['exited', 'dead', 'paused']);

interface ActionButtonsProps {
  deploymentId: string | null;
  state: AutomationState | null;
}

export function ActionButtons({ deploymentId, state }: ActionButtonsProps) {
  const [inFlight, setInFlight] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRunning = state ? RUNNING_STATES.has(state) : false;
  const isStopped = state ? STOPPED_STATES.has(state) : false;
  const disabled = !deploymentId;

  const run = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      if (!deploymentId) return;
      setInFlight(action);
      setError(null);
      try {
        if (action === 'start') await api.startAutomation(deploymentId);
        else if (action === 'stop') await api.stopAutomation(deploymentId);
        else await api.restartAutomation(deploymentId);
      } catch (err) {
        setError(`${action} failed: ${String(err)}`);
      } finally {
        setInFlight(null);
      }
    },
    [deploymentId],
  );

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
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
