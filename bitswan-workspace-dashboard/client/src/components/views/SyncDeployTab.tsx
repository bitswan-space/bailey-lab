import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { useSessions } from '@/components/agents/SessionProvider';
import type { AutomationStage, BusinessProcess, DeployedAutomation, Copy } from '@/types';
import { AutomationCard } from '@/components/automations/AutomationCard';
import { InspectModal, type InspectStage } from '@/components/automations/InspectModal';
import {
  RemoveConfirmDialog,
  type RemoveTarget,
} from '@/components/automations/RemoveConfirmDialog';
import { NewAutomationDialog } from '@/components/automations/NewAutomationDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { api, isTransientNetworkError } from '@/lib/api';
import { deployBpWithToast } from '@/lib/deployBp';
import { cn } from '@/lib/utils';

// See the old DeploymentsView for the rationale on the busy-state lifecycle.
const BUSY_TIMEOUT_MS = 15_000;

interface BusyEntry {
  stage: AutomationStage;
  expect: 'deployed' | 'undeployed';
  startedAt: number;
}

interface CardEntry {
  automation: DeployedAutomation | undefined;
  relativePath: string;
}

interface SyncDeployTabProps {
  bp: BusinessProcess;
  wt: Copy;
  /** Flips the shell to the Coding Agent tab (the sync session runs there). */
  onShowAgents: () => void;
}

/**
 * The Sync & Deploy tab — the old worktree Overview, reshaped per the design:
 * an explainer header with ONE primary "Sync & Deploy" action (today's sync
 * flow: rebases the copy onto main; gitops then auto-deploys changed
 * automations to dev), plus the copy's live-dev automation cards.
 * The Specification/README moved to the Description tab; Delete copy
 * moved to the copy switcher.
 */
export function SyncDeployTab({ bp, wt, onShowAgents }: SyncDeployTabProps) {
  const { automations: raw, status } = useAutomations();
  // Whole-BP live-dev deploy in flight — blocks the Deploy button until the
  // polled deploy task reaches a terminal state.
  const [bpDeploying, setBpDeploying] = useState(false);
  const prefix = `copies/${wt.name}/${bp.name}`;
  // eslint-disable-next-line no-restricted-syntax -- null = modal closed
  const [inspectName, setInspectName] = useState<string | null>(null);
  // Busy stays set from request fire until the SSE feed confirms the
  // expected state, or the safety timeout fires.
  // eslint-disable-next-line no-restricted-syntax -- null = not busy
  const [busy, setBusy] = useState<Record<string, BusyEntry | null>>({});
  const [newAutomationOpen, setNewAutomationOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const { startSyncSession, setSelectedFor, agentStatus, ensureAgent } = useSessions();
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveTarget & { automationName: string }) | null
  >(null);

  // Group copy automations by name. Both deployed (stage='live-dev') and
  // discoverable (stage=null) entries contribute so the card grid shows
  // automations that exist on disk but haven't been started yet.
  const byName = useMemo(() => {
    const out = new Map<string, CardEntry>();
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (rel !== prefix && !rel.startsWith(`${prefix}/`)) continue;
      const key = a.automation_name ?? a.name;
      const existing = out.get(key);
      const isDeployed = a.stage === 'live-dev' && a.deployment_id;
      if (existing) {
        if (isDeployed && !existing.automation) existing.automation = a;
        if (!existing.relativePath && rel) existing.relativePath = rel;
      } else {
        out.set(key, {
          automation: isDeployed ? a : undefined,
          relativePath: rel,
        });
      }
    }
    return out;
  }, [raw, prefix]);

  const sorted = useMemo(
    () => Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [byName],
  );

  const inspectStages: InspectStage[] = useMemo(() => {
    if (!inspectName) return [];
    const entry = byName.get(inspectName);
    return [
      {
        id: 'live-dev',
        label: 'Live dev',
        automation: entry?.automation,
        relativePath: entry?.relativePath,
      },
    ];
  }, [byName, inspectName]);

  const handleClose = useCallback(() => setInspectName(null), []);

  // Clear busy entries once the live snapshot reflects the expected state, or
  // after the safety timeout.
  useEffect(() => {
    setBusy((cur) => {
      let changed = false;
      const next = { ...cur };
      const now = Date.now();
      for (const [name, entry] of Object.entries(cur)) {
        if (!entry) continue;
        const aut = byName.get(name)?.automation;
        const isDeployed = !!aut?.deployment_id;
        const satisfied =
          entry.expect === 'deployed' ? isDeployed : !isDeployed;
        if (satisfied || now - entry.startedAt > BUSY_TIMEOUT_MS) {
          next[name] = null;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [byName]);

  useEffect(() => {
    const anyBusy = Object.values(busy).some(Boolean);
    if (!anyBusy) return;
    const t = setTimeout(() => {
      setBusy((cur) => {
        let changed = false;
        const next = { ...cur };
        const now = Date.now();
        for (const [name, entry] of Object.entries(cur)) {
          if (entry && now - entry.startedAt > BUSY_TIMEOUT_MS) {
            next[name] = null;
            changed = true;
          }
        }
        return changed ? next : cur;
      });
    }, BUSY_TIMEOUT_MS + 200);
    return () => clearTimeout(t);
  }, [busy]);

  // Start the whole business process in live-dev with one click.
  const runDeployBP = useCallback(async () => {
    const members = Array.from(byName.keys());
    setBpDeploying(true);
    setBusy((m) => {
      const next = { ...m };
      for (const name of members) {
        next[name] = {
          stage: 'live-dev',
          expect: 'deployed',
          startedAt: Date.now(),
        };
      }
      return next;
    });
    try {
      const outcome = await deployBpWithToast({
        bp: bp.name,
        stage: 'live-dev',
        copy: wt.name,
        loading: `Starting ${bp.name} in ${wt.name}…`,
        success: `${bp.name} started in ${wt.name}`,
        failurePrefix: `Failed to start ${bp.name}`,
      });
      if (outcome !== 'completed') {
        setBusy((m) => {
          const next = { ...m };
          for (const name of members) next[name] = null;
          return next;
        });
      }
    } finally {
      setBpDeploying(false);
    }
  }, [bp.name, byName, wt.name]);

  const runRemove = useCallback(async (name: string, deploymentId: string) => {
    setBusy((m) => ({
      ...m,
      [name]: { stage: 'live-dev', expect: 'undeployed', startedAt: Date.now() },
    }));
    const work = api.removeAutomation(deploymentId);
    toast.promise(work, {
      loading: `Removing ${name} live-dev…`,
      success: `${name} live-dev removed`,
      error: (err: unknown) =>
        isTransientNetworkError(err)
          ? `${name} live-dev removed`
          : `Failed to remove ${name}: ${String(err)}`,
    });
    try {
      await work;
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        setBusy((m) => ({ ...m, [name]: null }));
      }
    }
  }, []);

  const bpBusy = bpDeploying || Object.values(busy).some(Boolean);

  return (
    <div className="flex-1 overflow-auto bg-background">
      {/* Explainer header (design: worktree.jsx Sync & Deploy) */}
      <div className="flex items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <Rocket className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">
            Sync &amp; Deploy
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Rebases{' '}
            <strong className="font-mono font-semibold text-foreground">
              {wt.name}
            </strong>{' '}
            onto the <strong className="text-foreground">main code area</strong>,
            then builds and deploys every changed container in this business
            process to <strong className="text-foreground">dev</strong>.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                wt.synced
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700',
              )}
            >
              {wt.synced ? 'Up to date with main' : 'Unsynced'}
            </span>
            <span className="text-xs text-muted-foreground">{wt.branch}</span>
          </div>
        </div>
        <Button size="lg" className="shrink-0" onClick={() => setSyncOpen(true)}>
          <Rocket className="size-4" aria-hidden />
          Sync &amp; Deploy
        </Button>
      </div>

      <div className="flex flex-col gap-5 px-7 py-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Automations · live-dev
            </div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              Each automation runs locally with hot-reload. Sync the copy to
              deploy.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {sorted.length > 0 && (
              <Button
                size="sm"
                onClick={() => void runDeployBP()}
                disabled={bpBusy}
              >
                <Rocket className="size-3.5" aria-hidden />
                {bpDeploying ? 'Deploying…' : 'Deploy'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNewAutomationOpen(true)}
            >
              <Plus className="size-3.5" aria-hidden />
              New automation
            </Button>
          </div>
        </div>

        {status === 'connecting' && sorted.length === 0 ? (
          <EmptyState message="Loading automations…" />
        ) : sorted.length === 0 ? (
          <EmptyState message="No live-dev automations for this copy." />
        ) : (
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {sorted.map(([name, entry]) => (
              <AutomationCard
                key={name}
                name={name}
                stages={[
                  {
                    id: 'live-dev',
                    label: 'Live dev',
                    short: 'Live dev',
                    automation: entry.automation,
                  },
                ]}
                deployableStages={[]}
                promotableStages={[]}
                busyStage={busy[name]?.stage ?? null}
                onInspect={() => setInspectName(name)}
                onDeploy={() => {
                  // Per-automation deploy is disabled (deployableStages is
                  // empty); deploys happen at the BP level via "Deploy".
                }}
                onPromote={() => {
                  // Single live-dev stage — promotion is not applicable here.
                }}
                onRemove={(deploymentId) => {
                  setRemoveTarget({
                    deploymentId,
                    name,
                    automationName: name,
                    stageLabel: 'Live dev',
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>

      <InspectModal
        open={inspectName !== null}
        onClose={handleClose}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="liveDev"
        copy={wt.name}
        actionBusy={inspectName ? !!busy[inspectName] : false}
        onRemove={(deploymentId) => {
          if (!inspectName) return;
          setRemoveTarget({
            deploymentId,
            name: inspectName,
            automationName: inspectName,
            stageLabel: 'Live dev',
          });
        }}
      />

      <RemoveConfirmDialog
        target={removeTarget}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return;
          const { automationName, deploymentId } = removeTarget;
          setRemoveTarget(null);
          void runRemove(automationName, deploymentId);
        }}
      />

      <NewAutomationDialog
        open={newAutomationOpen}
        onOpenChange={setNewAutomationOpen}
        bpId={bp.id}
        copy={wt.name}
        existingNames={sorted.map(([n]) => n)}
      />

      <AlertDialog open={syncOpen} onOpenChange={setSyncOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Sync copy &quot;{wt.name}&quot; with main?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Commits any work in progress and rebases this copy onto the
              latest <code>main</code> with plain git (<code>git pull --rebase</code>),
              then fast-forward pushes it. If the rebase hits conflicts, a
              coding-agent session opens at the copy root to walk you through
              resolving them. After a successful sync, changed automations are
              deployed to dev automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                setSyncOpen(false);
                if (agentStatus === 'idle' || agentStatus === 'failed') {
                  try {
                    await ensureAgent();
                  } catch {
                    // surfaces via agentStatus; the session will still attempt to spawn
                  }
                }
                const id = startSyncSession(wt.name);
                // Pre-select for the current BP scope so flipping to the
                // Coding Agent tab lands on the new sync terminal without an
                // extra click.
                setSelectedFor({ copy: wt.name, bp: bp.name }, id);
                onShowAgents();
              }}
            >
              Sync &amp; Deploy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
