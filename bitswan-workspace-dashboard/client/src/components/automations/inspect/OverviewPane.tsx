import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { api } from '@/lib/api';
import type { DockerInspect } from '@/types';
import { InspectGroup } from './InspectGroup';
import {
  healthRows,
  identityRows,
  imageRows,
  mountRows,
  networkRows,
  resourceRows,
} from './docker-inspect-rows';

interface OverviewPaneProps {
  deploymentId: string | null;
}

export function OverviewPane({ deploymentId }: OverviewPaneProps) {
  const [containers, setContainers] = useState<DockerInspect[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!deploymentId) {
      setContainers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIdx(0);
    api
      .inspectAutomation(deploymentId)
      .then((rows) => {
        if (!cancelled) setContainers(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentId]);

  if (!deploymentId) return <EmptyState message="Not deployed for this stage." />;
  if (loading) return <EmptyState message="Loading container details…" />;
  if (error) return <EmptyState message={`Failed to load: ${error}`} />;
  if (containers.length === 0)
    return <EmptyState message="No container found for this deployment." />;

  const c = containers[idx]!;
  return (
    <div className="flex flex-col gap-4">
      {containers.length > 1 && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Container {idx + 1} of {containers.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.min(containers.length - 1, i + 1))}
              disabled={idx === containers.length - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InspectGroup heading="Identity" rows={identityRows(c)} />
        <InspectGroup heading="Image" rows={imageRows(c)} />
        <InspectGroup heading="Network" rows={networkRows(c)} />
        <InspectGroup heading="Resources" rows={resourceRows(c)} />
        <InspectGroup
          heading="Mounts"
          rows={mountRows(c)}
          fullSpan={c.Mounts && c.Mounts.length > 4}
        />
        {c.Config?.Healthcheck && (
          <InspectGroup heading="Health check" rows={healthRows(c)} />
        )}
      </div>
    </div>
  );
}
