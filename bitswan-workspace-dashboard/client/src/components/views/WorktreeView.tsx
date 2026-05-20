import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardCheck,
  FileText,
  GitPullRequest,
  LayoutDashboard,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import type {
  AutomationStage,
  BusinessProcess,
  DeployedAutomation,
  Worktree,
} from '@/types';
import { AgentsTab } from '@/components/agents/AgentsTab';
import { useSessions } from '@/components/agents/SessionProvider';
import { RequirementsTab } from '@/components/requirements/RequirementsTab';
import { FilesTab } from '@/components/files/FilesTab';
import { DiffTab } from '@/components/diff/DiffTab';
import { AutomationCard } from '@/components/automations/AutomationCard';
import { InspectModal, type InspectStage } from '@/components/automations/InspectModal';
import {
  RemoveConfirmDialog,
  type RemoveTarget,
} from '@/components/automations/RemoveConfirmDialog';
import { NewAutomationDialog } from '@/components/automations/NewAutomationDialog';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { api, isTransientNetworkError } from '@/lib/api';

const DEPLOYABLE_STAGES: AutomationStage[] = ['live-dev'];

interface WorktreeViewProps {
  /** `null` when the user is on a worktree scope but no BP is selected
   *  (e.g. fresh worktree, or all BPs filtered out). The view still
   *  renders so the user can manage the worktree itself (delete, etc.). */
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected for this scope
  bp: BusinessProcess | null;
  wt: Worktree;
}

const TAB_STORAGE_KEY = 'dashboard.worktreeTab';

type WorktreeTab = 'overview' | 'files' | 'diff' | 'agents' | 'requirements';

function readPersistedTab(): WorktreeTab {
  try {
    const raw = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (
      raw === 'agents' ||
      raw === 'requirements' ||
      raw === 'files' ||
      raw === 'diff'
    ) {
      return raw;
    }
  } catch {
    // ignore
  }
  return 'overview';
}

export function WorktreeView({ bp, wt }: WorktreeViewProps) {
  const [tab, setTab] = useState<WorktreeTab>(readPersistedTab);
  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
  }, [tab]);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) =>
        setTab(
          v === 'agents' || v === 'requirements' || v === 'files' || v === 'diff'
            ? (v as WorktreeTab)
            : 'overview',
        )
      }
      className="flex flex-1 flex-col overflow-hidden"
    >
      <TabsList className="mx-7 mt-4 inline-flex w-fit shrink-0 gap-1 self-start bg-muted/40">
        <TabsTrigger value="overview" className="gap-1.5">
          <LayoutDashboard className="size-3.5" aria-hidden />
          Overview
        </TabsTrigger>
        <TabsTrigger value="agents" className="gap-1.5">
          <TerminalSquare className="size-3.5" aria-hidden />
          Agents
        </TabsTrigger>
        <TabsTrigger value="requirements" className="gap-1.5">
          <ClipboardCheck className="size-3.5" aria-hidden />
          Requirements
        </TabsTrigger>
        <TabsTrigger value="files" className="gap-1.5">
          <FileText className="size-3.5" aria-hidden />
          Files
        </TabsTrigger>
        <TabsTrigger value="diff" className="gap-1.5">
          <GitPullRequest className="size-3.5" aria-hidden />
          Diff
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="flex-1 overflow-auto bg-background">
        <OverviewPane bp={bp} wt={wt} onShowAgents={() => setTab('agents')} />
      </TabsContent>

      <TabsContent value="files" className="flex-1 overflow-hidden bg-background">
        <FilesTab worktree={wt.name} bp={bp?.name ?? null} />
      </TabsContent>

      <TabsContent value="diff" className="flex-1 overflow-hidden bg-background">
        <DiffTab worktree={wt.name} />
      </TabsContent>

      <TabsContent
        value="requirements"
        className="flex-1 overflow-hidden bg-background"
      >
        {bp ? (
          <RequirementsTab
            worktree={wt.name}
            bp={bp.name}
            onShowAgents={() => setTab('agents')}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a business process from the sidebar to view its requirements.
          </div>
        )}
      </TabsContent>

      {/* forceMount keeps the Agents tree (and every SessionTerminal's
          WebSocket) alive when the user switches to Overview. Radix sets
          `data-state="inactive"` + `hidden` on the inactive content, so
          xterm doesn't paint while the tab is hidden but the agent
          sessions keep streaming in the background. */}
      <TabsContent
        value="agents"
        forceMount
        className="flex-1 overflow-hidden bg-white data-[state=inactive]:hidden"
      >
        {bp ? (
          <AgentsTab worktree={wt.name} bp={bp.name} branch={wt.branch || wt.name} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a business process from the sidebar to start agent sessions.
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

// See DeploymentsView for the rationale on the busy-state lifecycle.
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

function OverviewPane({
  bp,
  wt,
  onShowAgents,
}: {
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  bp: BusinessProcess | null;
  wt: Worktree;
  onShowAgents: () => void;
}) {
  const { automations: raw, status } = useAutomations();
  // No BP → no automations to list. The prefix becomes a guaranteed-miss so
  // the existing filter still runs cleanly without a separate code path.
  const prefix = bp ? `worktrees/${wt.name}/${bp.name}` : null;
  const [inspectName, setInspectName] = useState<string | null>(null);
  // Busy stays set from request fire until the SSE feed confirms the
  // expected state, or the safety timeout fires. Same shape as
  // DeploymentsView.
  const [busy, setBusy] = useState<Record<string, BusyEntry | null>>({});
  const [newAutomationOpen, setNewAutomationOpen] = useState(false);
  const [deleteWorktreeOpen, setDeleteWorktreeOpen] = useState(false);
  const [deletingWorktree, setDeletingWorktree] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const { startSyncSession, setSelectedFor, agentStatus, ensureAgent } = useSessions();
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveTarget & { automationName: string }) | null
  >(null);

  // Group worktree automations by name. Both deployed (stage='live-dev') and
  // discoverable (stage=null) entries contribute so the card grid shows
  // automations that exist on disk but haven't been started yet.
  const byName = useMemo(() => {
    const out = new Map<string, CardEntry>();
    if (!prefix) return out;
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
    return [
      {
        id: 'live-dev',
        label: 'Live dev',
        automation: byName.get(inspectName)?.automation,
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

  const runDeploy = useCallback(
    async (name: string, relativePath: string) => {
      setBusy((m) => ({
        ...m,
        [name]: { stage: 'live-dev', expect: 'deployed', startedAt: Date.now() },
      }));
      const work = api.deployAutomation({
        relative_path: relativePath,
        stage: 'live-dev',
        worktree: wt.name,
      });
      toast.promise(work, {
        loading: `Starting ${name} live-dev…`,
        success: `${name} started in ${wt.name}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} started in ${wt.name}`
            : `Failed to start ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          setBusy((m) => ({ ...m, [name]: null }));
        }
      }
    },
    [wt.name],
  );

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

  // Editor-parity flow: best-effort stop every live-dev deployment in this
  // worktree before asking gitops to remove the directory. Gitops's
  // `DELETE /worktrees/<name>` succeeds even if containers are still
  // running, but cleaning them up first avoids stranded containers
  // pointing at a now-deleted bind-mount.
  const runDeleteWorktree = useCallback(async () => {
    setDeletingWorktree(true);
    try {
      // Stop every live-dev deployment in this worktree, regardless of BP —
      // we're tearing down the whole tree, not just the currently-selected
      // BP's slice of it.
      const wtPrefix = `worktrees/${wt.name}/`;
      const liveDev = raw.filter((a) => {
        const rel = a.relative_path ?? '';
        return (
          rel.startsWith(wtPrefix) &&
          a.deployment_id &&
          a.stage === 'live-dev'
        );
      });
      await Promise.allSettled(
        liveDev.map((a) =>
          a.deployment_id ? api.removeAutomation(a.deployment_id) : Promise.resolve(),
        ),
      );
      const work = api.deleteWorktree(wt.name);
      toast.promise(work, {
        loading: `Deleting worktree "${wt.name}"…`,
        success: `Worktree "${wt.name}" deleted`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `Worktree "${wt.name}" deleted`
            : `Failed to delete worktree: ${String(err)}`,
      });
      try {
        await work;
        // Scope will reset to Deployments automatically via the
        // worktrees-snapshot effect in App.tsx once the SSE feed delivers
        // the new list without this entry.
      } catch {
        // toast handled the surfacing
      }
    } finally {
      setDeletingWorktree(false);
      setDeleteWorktreeOpen(false);
    }
  }, [raw, wt.name]);

  return (
    <div className="flex flex-col gap-5 px-7 py-6">
      <SectionHeader
        eyebrow="Worktree"
        title={wt.name}
        helper={
          <>
            {wt.branch} ·{' '}
            {wt.synced ? (
              <span className="text-emerald-600">synced with main</span>
            ) : (
              <span className="text-amber-600">unsynced</span>
            )}
          </>
        }
        right={
          <div className="flex items-center gap-2">
            {bp && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setNewAutomationOpen(true)}
              >
                <Plus className="size-3.5" aria-hidden />
                New automation
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSyncOpen(true)}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Sync
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteWorktreeOpen(true)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete worktree
            </Button>
          </div>
        }
      />

      {!bp ? (
        <EmptyState message="No business process selected. Create one with the + in the sidebar, or pick an existing one." />
      ) : status === 'connecting' && sorted.length === 0 ? (
        <EmptyState message="Loading automations…" />
      ) : sorted.length === 0 ? (
        <EmptyState message="No live-dev automations for this worktree." />
      ) : (
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {sorted.map(([name, entry]) => (
            <AutomationCard
              key={name}
              name={name}
              stages={[{
                id: 'live-dev',
                label: 'Live dev',
                short: 'Live dev',
                automation: entry.automation,
              }]}
              deployableStages={DEPLOYABLE_STAGES}
              busyStage={busy[name]?.stage ?? null}
              onInspect={() => setInspectName(name)}
              onDeploy={() => {
                void runDeploy(name, entry.relativePath);
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

      {bp && <ReadmeCard bpId={bp.id} worktree={wt.name} />}

      <InspectModal
        open={inspectName !== null}
        onClose={handleClose}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="liveDev"
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

      {bp && (
        <NewAutomationDialog
          open={newAutomationOpen}
          onOpenChange={setNewAutomationOpen}
          bpId={bp.id}
          worktree={wt.name}
          existingNames={sorted.map(([n]) => n)}
        />
      )}

      <AlertDialog
        open={deleteWorktreeOpen}
        onOpenChange={(o) => !deletingWorktree && setDeleteWorktreeOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree &quot;{wt.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This force-removes the worktree directory and the{' '}
              <code>{wt.branch}</code> branch, and drops the worktree&apos;s
              postgres database. Any live-dev deployments under this
              worktree will be stopped first. Uncommitted changes are{' '}
              <strong>lost</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingWorktree}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingWorktree}
              onClick={(e) => {
                // Block AlertDialog's default close-on-action so the
                // dialog stays up while the async delete runs; we'll
                // close it ourselves in the handler.
                e.preventDefault();
                void runDeleteWorktree();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncOpen} onOpenChange={setSyncOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync worktree &quot;{wt.name}&quot; with main?</AlertDialogTitle>
            <AlertDialogDescription>
              Opens a coding-agent session at the worktree root that runs the{' '}
              <code>bitswan-coding-agent vcs sync</code> flow. Uncommitted
              changes are committed as <code>pre-sync-commit</code> first; if
              merge conflicts occur the agent will walk you through resolving
              them via <code>vcs sync-continue</code>.
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
                // Pre-select for the current BP scope (if any) so flipping to
                // Agents tab lands on the new sync terminal without an extra
                // click. Sync sessions are visible from any BP's Agents tab in
                // the same worktree.
                if (bp) {
                  setSelectedFor({ worktree: wt.name, bp: bp.name }, id);
                }
                onShowAgents();
              }}
            >
              Sync
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
