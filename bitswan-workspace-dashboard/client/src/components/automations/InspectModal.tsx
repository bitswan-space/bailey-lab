import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AutomationStage, DeployedAutomation } from '@/types';
import { ActionButtons } from './inspect/ActionButtons';
import { OverviewPane } from './inspect/OverviewPane';
import { LogsPane } from './inspect/LogsPane';
import { StageActions } from './inspect/StageActions';

export interface InspectStage {
  id: AutomationStage;
  label: string;
  automation: DeployedAutomation | undefined;
  /** Workspace-relative source path — enables the per-stage Deploy action. */
  relativePath?: string;
}

interface InspectModalProps {
  open: boolean;
  onClose: () => void;
  name: string;
  stages: InspectStage[];
  mode: 'deployments' | 'liveDev';
  /** Worktree the source lives in (live-dev deploys only). */
  worktree?: string;
  /** Parent-tracked in-flight state for the stage actions (e.g. a confirmed
   *  Remove waiting for the SSE snapshot to reflect it). */
  actionBusy?: boolean;
  /** When set, deployed stages show a Remove button that delegates to the
   *  parent's confirm dialog. */
  onRemove?: (deploymentId: string, stage: InspectStage) => void;
}

export function InspectModal({
  open,
  onClose,
  name,
  stages,
  mode,
  worktree,
  actionBusy,
  onRemove,
}: InspectModalProps) {
  const [stageId, setStageId] = useState<AutomationStage>(stages[0]?.id ?? 'dev');
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');

  // Reset state when the modal is opened for a different automation. `stages`
  // is intentionally *not* a dep — the parent rebuilds the array on every SSE
  // tick (so button states update live), but we only want to reset selection
  // when the inspect target itself changes.
  useEffect(() => {
    if (!open) return;
    setStageId((cur) => (stagesRef.current.some((s) => s.id === cur) ? cur : stagesRef.current[0]?.id ?? 'dev'));
    setTab('overview');
  }, [open, name]);

  // Keep a ref to the latest stages so the reset effect can pick a valid id
  // without depending on the array reference (which churns each render).
  const stagesRef = useRef(stages);
  stagesRef.current = stages;

  const stage = useMemo(
    () => stages.find((s) => s.id === stageId) ?? stages[0],
    [stages, stageId],
  );
  const aut = stage?.automation;
  const deploymentId = aut?.deployment_id ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-7xl flex-col gap-0 overflow-hidden p-0">
        <header className="flex items-center gap-2.5 border-b border-border px-5 py-3.5 pr-12">
          <Activity className="size-4 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              Inspect <span className="font-mono">{name}</span>
            </DialogTitle>
            <div className="text-xs text-muted-foreground">
              {mode === 'liveDev'
                ? 'Local container — logs and details for this worktree'
                : 'Container details and logs — per stage'}
            </div>
          </div>
          <StageActions
            name={name}
            stage={stage}
            mode={mode}
            worktree={worktree}
            busy={actionBusy}
            onRemove={onRemove}
          />
          <ActionButtons
            deploymentId={deploymentId}
            state={aut?.state ?? null}
            automationName={name}
          />
        </header>

        {mode === 'deployments' && stages.length > 1 && (
          <div className="border-b border-border bg-muted/30 px-5 py-1.5">
            <Tabs value={stageId} onValueChange={(v) => setStageId(v as AutomationStage)}>
              <TabsList className="bg-transparent p-0">
                {stages.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={s.id}
                    className="data-[state=active]:bg-background"
                  >
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        )}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as 'overview' | 'logs')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-5 mt-3 w-fit shrink-0 self-start bg-muted/40">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <OverviewPane deploymentId={deploymentId} />
          </TabsContent>

          <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden">
            <LogsPane deploymentId={deploymentId} active={tab === 'logs' && open} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
