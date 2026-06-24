import { useState } from 'react';
import { Rocket, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, isTransientNetworkError } from '@/lib/api';
import type { InspectStage } from '../InspectModal';

interface StageActionsProps {
  /** The automation name (for toast copy). */
  name: string;
  /** The currently-active stage in the modal. */
  stage: InspectStage | undefined;
  mode: 'deployments' | 'liveDev';
  /** Required for live-dev deploys (the copy the source lives in). */
  copy?: string;
  /** Parent-tracked in-flight state (e.g. a confirmed Remove waiting for the
   *  SSE snapshot) — disables the actions to close the re-issue race. */
  busy?: boolean;
  /** Remove is delegated upward so the parent can show its confirm dialog
   *  (avoids nesting an AlertDialog inside the inspect Dialog). */
  onRemove?: (deploymentId: string, stage: InspectStage) => void;
}

/**
 * Per-stage Deploy / Start-live-dev / Remove actions inside the Inspect
 * modal — the per-automation lifecycle actions that used to live on the
 * automation cards.
 */
export function StageActions({
  name,
  stage,
  mode,
  copy,
  busy,
  onRemove,
}: StageActionsProps) {
  const [inFlight, setInFlight] = useState(false);
  const disabled = inFlight || !!busy;

  if (!stage) return <></>;

  const deploymentId = stage.automation?.deployment_id ?? null;
  const canDeploy =
    !deploymentId &&
    !!stage.relativePath &&
    (mode === 'liveDev' ? true : stage.id === 'dev');

  const runDeploy = async () => {
    if (!stage.relativePath) return;
    setInFlight(true);
    const isLiveDev = mode === 'liveDev';
    const work = api.deployAutomation({
      relative_path: stage.relativePath,
      stage: isLiveDev ? 'live-dev' : 'dev',
      ...(isLiveDev && copy ? { copy } : {}),
    });
    toast.promise(work, {
      loading: isLiveDev ? `Starting ${name} live-dev…` : `Deploying ${name} to dev…`,
      success: isLiveDev ? `${name} live-dev started` : `${name} deployed to dev`,
      error: (err: unknown) =>
        isTransientNetworkError(err)
          ? isLiveDev
            ? `${name} live-dev started`
            : `${name} deployed to dev`
          : `Failed to deploy ${name}: ${String(err)}`,
    });
    try {
      await work;
    } catch {
      // toast handled it
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {deploymentId && onRemove ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRemove(deploymentId, stage)}
          disabled={disabled}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Remove
        </Button>
      ) : canDeploy ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runDeploy()}
          disabled={disabled}
        >
          <Rocket className="size-3.5" aria-hidden />
          {mode === 'liveDev' ? 'Start live dev' : 'Deploy'}
        </Button>
      ) : null}
    </div>
  );
}
