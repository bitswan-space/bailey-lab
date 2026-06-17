import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowRight,
  Boxes,
  Check,
  Code2,
  Download,
  ExternalLink,
  FileText,
  ChevronRight,
  FlaskConical,
  Folder,
  GitCompare,
  History,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  Play,
  RotateCcw,
  Rocket,
  Scaling,
  Search,
  Shield,
  Square,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { DiffView } from '@/components/diff/DiffView';
import { promoteBpWithToast } from '@/lib/deployBp';
import { STATUS_META, stateToDisplay } from '@/lib/status';
import { api, isTransientNetworkError, type BpHistory, type BpHistoryEntry } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import type { BusinessProcess } from '@/types';

type StageId = 'dev' | 'staging' | 'production';
const STAGES: { id: StageId; label: string; icon: LucideIcon }[] = [
  { id: 'dev', label: 'Development', icon: Code2 },
  { id: 'staging', label: 'Staging', icon: FlaskConical },
  { id: 'production', label: 'Production', icon: Rocket },
];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.label]),
);

type Section =
  | 'history'
  | 'secrets'
  | 'containers'
  | 'backups'
  | 'firewall'
  | 'supply'
  | 'access';

function short(sha: string | null | undefined, n = 12): string {
  return (sha ?? '').slice(0, n);
}

// ── Section tab (underlined) ────────────────────────────────────────────────
function SectionTab({
  id,
  active,
  icon: Icon,
  label,
  count,
  onSelect,
}: {
  id: Section;
  active: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  onSelect: (id: Section) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        '-mb-px inline-flex h-[38px] items-center gap-1.5 border-b-2 px-1 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
      {typeof count === 'number' && (
        <span
          className={cn(
            'rounded-full px-1.5 text-[10px] font-bold',
            active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── Pipeline node ───────────────────────────────────────────────────────────
function StageNode({
  stage,
  deployed,
  active,
  onClick,
}: {
  stage: { id: StageId; label: string; icon: LucideIcon };
  deployed: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = stage.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!deployed && !active}
      className={cn(
        'flex shrink-0 flex-col items-center gap-1.5 bg-background px-1',
        !deployed && !active && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'relative flex size-[52px] items-center justify-center rounded-full',
          deployed ? 'bg-emerald-500 text-white' : 'border-[1.5px] border-dashed border-border text-muted-foreground',
          active && 'ring-[3px] ring-foreground ring-offset-0',
        )}
      >
        <Icon className="size-[22px]" aria-hidden />
        <span className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-background bg-background">
          {deployed ? (
            <Check className="size-3 text-emerald-500" aria-hidden />
          ) : (
            <span className="size-1.5 rounded-full bg-zinc-300" />
          )}
        </span>
      </span>
      <span
        className={cn(
          'text-[11px] font-bold uppercase tracking-wide',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {stage.label}
      </span>
    </button>
  );
}

// ── Empty placeholder for unimplemented section tabs ────────────────────────
function EmptyTab({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
      <Icon className="size-7 text-muted-foreground" aria-hidden />
      <div className="text-sm font-semibold text-foreground">{label}</div>
      <div className="max-w-sm text-[13px] text-muted-foreground">
        Not implemented yet — coming in a later release.
      </div>
    </div>
  );
}

function entryTone(e: BpHistoryEntry, isCurrent: boolean) {
  if (e.status === 'rolled-back')
    return { dot: 'bg-amber-500', label: 'Rolled back', cls: 'bg-amber-100 text-amber-700' };
  if (e.status === 'failed')
    return { dot: 'bg-red-500', label: 'Failed', cls: 'bg-red-100 text-red-700' };
  if (isCurrent) return { dot: 'bg-emerald-500', label: 'Current', cls: 'bg-primary/10 text-primary' };
  return { dot: 'bg-emerald-500', label: 'Deployed', cls: 'bg-emerald-100 text-emerald-700' };
}

// ── Inspect modal (per deployment) ──────────────────────────────────────────
type InspectPanel = 'scale' | 'files' | 'diff' | 'secrets' | 'image';
function InspectModal({
  bp,
  stage,
  entry,
  current,
  stageLabel,
  currentReplicas,
  onClose,
  onScaled,
}: {
  bp: string;
  stage: StageId;
  entry: BpHistoryEntry;
  current: BpHistoryEntry | null;
  stageLabel: string;
  currentReplicas: number;
  onClose: () => void;
  onScaled: () => void;
}) {
  const isCurrent = !!current && entry.commit === current.commit;
  const [panel, setPanel] = useState<InspectPanel>(isCurrent ? 'scale' : 'diff');
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const commit = entry.source_commit ?? '';
  // Scale
  const [replicas, setReplicas] = useState(Math.max(1, currentReplicas || 1));
  const [scaling, setScaling] = useState(false);
  // Files
  const [filePath, setFilePath] = useState('');
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded
  const [files, setFiles] = useState<
    import('@/lib/api').BpFiles | null
  >(null);
  const [filesLoading, setFilesLoading] = useState(false);

  useEffect(() => {
    if (panel !== 'diff' || !current?.source_commit || !entry.source_commit) return;
    let alive = true;
    setDiffLoading(true);
    setDiff('');
    api
      .bpDiff(bp, entry.source_commit, current.source_commit)
      .then((r) => alive && setDiff(r.diff))
      .catch((e) => alive && setDiff(`Failed to load diff: ${String(e)}`))
      .finally(() => alive && setDiffLoading(false));
    return () => {
      alive = false;
    };
  }, [panel, bp, entry, current]);

  useEffect(() => {
    if (panel !== 'files' || !commit) return;
    let alive = true;
    setFilesLoading(true);
    api
      .bpFiles(bp, commit, filePath)
      .then((r) => alive && setFiles(r))
      .catch(() => alive && setFiles(null))
      .finally(() => alive && setFilesLoading(false));
    return () => {
      alive = false;
    };
  }, [panel, bp, commit, filePath]);

  const applyScale = useCallback(async () => {
    setScaling(true);
    const work = api.bpScale(bp, stage, replicas);
    toast.promise(work, {
      loading: `Scaling ${bp} to ${replicas}…`,
      success: `${bp} scaled to ${replicas} replica${replicas === 1 ? '' : 's'}`,
      error: (e: unknown) => `Scale failed: ${String(e)}`,
    });
    try {
      await work;
      onScaled();
    } catch {
      /* toast handled */
    } finally {
      setScaling(false);
    }
  }, [bp, stage, replicas, onScaled]);

  const tabs: { id: InspectPanel; icon: LucideIcon; label: string }[] = [
    ...(isCurrent ? [{ id: 'scale' as const, icon: Scaling, label: 'Scale' }] : []),
    { id: 'files', icon: FileText, label: 'Files' },
    { id: 'diff', icon: GitCompare, label: 'Diff vs current' },
    { id: 'secrets', icon: KeyRound, label: 'Secrets snapshot' },
    { id: 'image', icon: Download, label: 'Download image' },
  ];

  const crumbs = filePath ? filePath.split('/') : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-5"
      onClick={onClose}
    >
      <div
        className="flex h-[620px] max-h-[90vh] w-[960px] max-w-[96vw] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left rail */}
        <div className="flex w-[210px] shrink-0 flex-col border-r border-border bg-muted/40">
          <div className="border-b border-border px-4 py-3">
            <div className="text-[13px] font-bold text-foreground">Inspect</div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {stageLabel} · {short(entry.source_commit ?? entry.commit, 7)}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 p-2">
            {tabs.map((t) => {
              const on = panel === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPanel(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px]',
                    on
                      ? 'bg-background font-semibold text-foreground shadow-sm'
                      : 'font-medium text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-3.5', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* Right content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <div className="flex-1 text-sm font-semibold text-foreground">
              {tabs.find((t) => t.id === panel)?.label}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {panel === 'diff' ? (
              <DiffView
                path={`${bp} — ${short(entry.source_commit, 7)} vs current`}
                diff={diff || (diffLoading ? '' : 'No changes.')}
                loading={diffLoading}
              />
            ) : panel === 'scale' ? (
              <div className="flex flex-col gap-4 p-5">
                <div className="text-[13px] text-foreground">
                  Number of running replicas for every container in this business
                  process at {stageLabel}.
                </div>
                <div className="flex items-center gap-2.5">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setReplicas(n)}
                      className={cn(
                        'flex size-10 items-center justify-center rounded-lg border text-sm font-semibold',
                        n === replicas
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-foreground hover:bg-muted',
                      )}
                    >
                      {n}
                    </button>
                  ))}
                  <span className="ml-2 text-xs text-muted-foreground">
                    currently {currentReplicas} replica{currentReplicas === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" disabled={scaling} onClick={() => void applyScale()}>
                    {scaling ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Check className="size-3.5" aria-hidden />
                    )}
                    Apply
                  </Button>
                </div>
              </div>
            ) : panel === 'files' ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                  <button type="button" className="hover:text-foreground" onClick={() => setFilePath('')}>
                    {bp}
                  </button>
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <ChevronRight className="size-3" aria-hidden />
                      <button
                        type="button"
                        className="hover:text-foreground"
                        onClick={() => setFilePath(crumbs.slice(0, i + 1).join('/'))}
                      >
                        {c}
                      </button>
                    </span>
                  ))}
                </div>
                {filesLoading ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
                  </div>
                ) : files?.kind === 'file' ? (
                  <pre className="m-0 flex-1 overflow-auto whitespace-pre px-4 py-3 font-mono text-[12px] leading-5 text-foreground">
                    {files.content}
                    {files.truncated ? '\n… (truncated)' : ''}
                  </pre>
                ) : files?.kind === 'tree' ? (
                  <div className="flex-1 overflow-auto p-2">
                    {filePath && (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted"
                        onClick={() => setFilePath(crumbs.slice(0, -1).join('/'))}
                      >
                        <Folder className="size-3.5" aria-hidden /> ..
                      </button>
                    )}
                    {files.entries.map((e) => (
                      <button
                        key={e.path}
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
                        onClick={() => setFilePath(e.path)}
                      >
                        {e.kind === 'folder' ? (
                          <Folder className="size-3.5 text-primary" aria-hidden />
                        ) : (
                          <FileText className="size-3.5 text-muted-foreground" aria-hidden />
                        )}
                        {e.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center text-sm text-muted-foreground">No files.</div>
                )}
              </div>
            ) : panel === 'image' ? (
              <div className="flex flex-col gap-4 p-5">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Bundles the deployment's source at{' '}
                  <span className="font-mono">{short(commit, 8)}</span>, the built
                  container image(s), and the database schema into one archive you
                  can use to recreate this deployment.
                </p>
                <div className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  {['Container images (docker save)', 'Source code at the deployed commit', 'Database schema (pg_dump)'].map((l) => (
                    <div key={l} className="flex items-center gap-2">
                      <Check className="size-3.5 text-emerald-500" aria-hidden />
                      {l}
                    </div>
                  ))}
                </div>
                <div>
                  <a
                    href={api.bpBundleUrl(bp, stage, commit)}
                    download
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <Download className="size-3.5" aria-hidden />
                    Download bundle
                  </a>
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    Can be large (hundreds of MB) — the download may take a while.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                <Lock className="size-6" aria-hidden />
                <div className="font-medium text-foreground">Secrets snapshot</div>
                <div className="max-w-xs">Not implemented yet — coming in a later release.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Deployment card ─────────────────────────────────────────────────────────
function DeploymentCard({
  entry,
  isCurrent,
  stageLabel,
  busy,
  onRollback,
  onInspect,
}: {
  entry: BpHistoryEntry;
  isCurrent: boolean;
  stageLabel: string;
  busy: boolean;
  onRollback: () => void;
  onInspect: () => void;
}) {
  const tone = entryTone(entry, isCurrent);
  const ver = entry.source_commit ?? entry.commit;
  const members = Object.entries(entry.members ?? {});
  const firstImg = members.find(([, m]) => m.image_id)?.[1]?.image_id;
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-background px-4 py-3.5',
        isCurrent ? 'border-primary ring-1 ring-primary/20' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={cn('size-2.5 rounded-full', tone.dot)} aria-hidden />
        <span className="font-mono text-[13px] font-semibold text-foreground">{short(ver)}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', tone.cls)}>
          {isCurrent ? `Current on ${stageLabel}` : tone.label}
        </span>
        {entry.source && entry.source !== 'deploy' && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {entry.source === 'rollback' ? 'rollback' : `promoted from ${entry.source}`}
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">{entry.deployed_at}</span>
        <div className="flex items-center gap-1.5">
          {isCurrent ? (
            <Button variant="outline" size="sm" onClick={onInspect}>
              <Scaling className="size-3.5" aria-hidden />
              Scale
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRollback}>
              <Undo2 className="size-3.5" aria-hidden />
              Roll back
            </Button>
          )}
          <Button variant="default" size="sm" onClick={onInspect}>
            <Search className="size-3.5" aria-hidden />
            Inspect
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[12px] text-muted-foreground">
        {entry.deployed_by && <span>{entry.deployed_by}</span>}
        <span>{members.length} container{members.length === 1 ? '' : 's'}</span>
        {firstImg && <span className="font-mono">{firstImg.replace(/^sha256:/, '').slice(0, 12)}</span>}
      </div>
    </div>
  );
}

/**
 * Deployments page — recreates the wireframe: a stage pipeline (Development →
 * Staging → Production) with promote buttons, a rich per-stage card (status,
 * version, open-app, section tabs), and the section content. The **Deployment
 * history** tab is fully implemented (git-derived history, whole-BP rollback,
 * live service availability via Containers, and the per-deployment Inspect
 * modal with a real Diff-vs-current). Other section tabs are honest
 * placeholders for not-yet-built features.
 */
export function DeploymentsTab({ bp }: { bp: BusinessProcess }) {
  const { automations } = useAutomations();
  const [activeStage, setActiveStage] = useState<StageId>('dev');
  const [section, setSection] = useState<Section>('history');
  const [byStage, setByStage] = useState<Record<string, BpHistory | null>>({});
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = no confirm
  const [confirm, setConfirm] = useState<BpHistoryEntry | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = modal closed
  const [inspect, setInspect] = useState<BpHistoryEntry | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    Promise.all(
      STAGES.map((s) =>
        api
          .bpHistory(bp.name, s.id)
          .then((h) => [s.id, h] as const)
          .catch(() => [s.id, null] as const),
      ),
    ).then((pairs) => {
      if (!alive) return;
      setByStage(Object.fromEntries(pairs));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [bp.name, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const data = byStage[activeStage] ?? null;
  const history = data?.history ?? [];
  const currentEntry = useMemo(
    () => history.find((e) => e.commit === data?.current) ?? history[0] ?? null,
    [history, data],
  );

  // Live containers for the current deployment (availability).
  const members = useMemo(() => {
    if (!currentEntry) return [];
    return Object.keys(currentEntry.members).map((id) => {
      const a = automations.find((x) => x.deployment_id === id);
      return {
        id,
        name: a?.automation_name ?? id,
        present: !!a?.deployment_id,
        display: a?.deployment_id ? stateToDisplay(a.state) : 'not-deployed',
        replicas: a?.replicas ?? 0,
        url: a?.automation_url ?? null,
        expose: a?.expose ?? false,
      };
    });
  }, [currentEntry, automations]);
  const frontends = members.filter((m) => m.expose);
  const replicaTotal = members.reduce((a, m) => a + (m.replicas || 0), 0);

  const runRollback = useCallback(
    async (entry: BpHistoryEntry) => {
      const ver = short(entry.source_commit ?? entry.commit, 8);
      setBusy(true);
      const work = api.bpRollback(bp.name, activeStage, entry.commit);
      toast.promise(work, {
        loading: `Rolling ${bp.name} back to ${ver}…`,
        success: `${bp.name} rolled back to ${ver}`,
        error: (e: unknown) => `Rollback failed: ${String(e)}`,
      });
      try {
        await work;
        refresh();
      } catch {
        /* toast handled */
      } finally {
        setBusy(false);
        setConfirm(null);
      }
    },
    [bp.name, activeStage, refresh],
  );

  const runPromote = useCallback(
    async (target: 'staging' | 'production') => {
      setBusy(true);
      await promoteBpWithToast({
        bp: bp.name,
        stage: target,
        loading: `Promoting ${bp.name} to ${target}…`,
        success: `${bp.name} promoted to ${target}`,
        failurePrefix: `Failed to promote ${bp.name} to ${target}`,
      });
      setBusy(false);
      refresh();
    },
    [bp.name, refresh],
  );

  const runContainer = useCallback(
    async (action: 'start' | 'stop' | 'restart', id: string, name: string) => {
      const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[action];
      const call =
        action === 'start'
          ? api.startAutomation(id)
          : action === 'stop'
            ? api.stopAutomation(id)
            : api.restartAutomation(id);
      toast.promise(call, {
        loading: `${verb} ${name}…`,
        success: `${name} ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`,
        error: (e: unknown) =>
          isTransientNetworkError(e) ? `${name} ${action}ed` : `Failed to ${action} ${name}`,
      });
      try {
        await call;
      } catch {
        /* toast handled */
      }
    },
    [],
  );

  const friendly = useMemo(() => {
    const failing = members.filter((m) => m.display === 'failed' || m.display === 'stopped').length;
    if (!currentEntry) return { label: 'Not deployed yet', color: 'text-muted-foreground', dot: 'bg-zinc-400' };
    if (failing > 0)
      return { label: `${failing} service${failing === 1 ? '' : 's'} not running`, color: 'text-red-600', dot: 'bg-red-500' };
    return { label: 'Healthy', color: 'text-emerald-600', dot: 'bg-emerald-500' };
  }, [members, currentEntry]);

  const SECTIONS: { id: Section; icon: LucideIcon; label: string; count?: number }[] = [
    { id: 'history', icon: History, label: 'Deployment history', count: history.length },
    { id: 'secrets', icon: KeyRound, label: 'Secrets' },
    { id: 'containers', icon: Boxes, label: 'Containers', count: members.length },
    { id: 'backups', icon: Archive, label: 'Backups' },
    { id: 'firewall', icon: Shield, label: 'Firewall' },
    { id: 'supply', icon: Boxes, label: 'Supply chain' },
    { id: 'access', icon: Users, label: 'Access control' },
  ];

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-5xl px-7 py-6">
        <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
          {/* Pipeline */}
          <div className="relative border-b border-border px-6 py-6">
            <div className="absolute left-[16%] right-[16%] top-[50px] h-0.5 bg-border" aria-hidden />
            <div className="relative z-10 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3">
              {STAGES.map((s, i) => {
                const sHist = byStage[s.id];
                const deployed = !!sHist && sHist.history.length > 0;
                const next = STAGES[i + 1];
                const srcCur =
                  sHist?.history.find((h) => h.commit === sHist.current)?.source_commit ?? null;
                const tgtCur = next
                  ? (byStage[next.id]?.history.find(
                      (h) => h.commit === byStage[next.id]?.current,
                    )?.source_commit ?? null)
                  : null;
                const canPromote = deployed && !!next && !busy && srcCur !== tgtCur;
                return (
                  <div key={s.id} className="contents">
                    <StageNode
                      stage={s}
                      deployed={deployed}
                      active={s.id === activeStage}
                      onClick={() => setActiveStage(s.id)}
                    />
                    {next && (
                      <div className="bg-background px-2">
                        <Button
                          variant={canPromote ? 'default' : 'outline'}
                          size="sm"
                          className="rounded-full"
                          disabled={!canPromote}
                          onClick={() => void runPromote(next.id as 'staging' | 'production')}
                          title={canPromote ? `Promote to ${next.label}` : `Nothing new to promote to ${next.label}`}
                        >
                          Promote
                          <ArrowRight className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Stage header */}
          <div className="flex flex-wrap items-start gap-4 border-b border-border px-6 py-5">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className={cn('size-3 rounded-full', friendly.dot)} aria-hidden />
              <div className="min-w-0">
                <div className="text-[18px] font-bold tracking-tight text-foreground">
                  {STAGE_LABEL[activeStage]}
                </div>
                <div className={cn('mt-0.5 text-[13px] font-semibold', friendly.color)}>
                  {friendly.label}
                  <span className="font-normal text-muted-foreground">
                    {currentEntry?.deployed_at ? ` · updated ${currentEntry.deployed_at}` : ' · never deployed'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3.5 text-[12px] text-muted-foreground">
              {currentEntry?.source_commit && (
                <span className="inline-flex items-center gap-1.5">
                  Version <span className="font-mono text-foreground">{short(currentEntry.source_commit, 8)}</span>
                </span>
              )}
              {replicaTotal > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3.5" aria-hidden />
                  {replicaTotal} replica{replicaTotal === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>

          {/* Open app */}
          {frontends.length > 0 && (
            <div className="border-b border-border px-6 py-4">
              <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Open app
              </div>
              <div className="flex flex-wrap gap-2.5">
                {frontends.map((f) => {
                  const deployed = f.display === 'running';
                  const inner = (
                    <>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-semibold text-foreground">
                          {f.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {deployed && f.url ? f.url.replace('https://', '') : 'Not deployed'}
                        </span>
                      </span>
                    </>
                  );
                  return deployed && f.url ? (
                    <a
                      key={f.id}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex w-[280px] max-w-full items-center gap-2.5 rounded-[10px] border border-border px-3.5 py-3 hover:border-primary/40 hover:shadow-sm"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div key={f.id} className="flex w-[280px] max-w-full items-center gap-2.5 rounded-[10px] border border-border bg-muted/30 px-3.5 py-3 opacity-75">
                      {inner}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section tabs */}
          <div className="flex flex-wrap items-center gap-4 border-b border-border px-6 pt-3.5">
            {SECTIONS.map((s) => (
              <SectionTab key={s.id} {...s} active={section === s.id} onSelect={setSection} />
            ))}
          </div>

          {/* Section content */}
          <div className="bg-muted/30 px-6 py-5">
            {!loaded ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </div>
            ) : section === 'history' ? (
              history.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  <History className="mx-auto size-7 text-muted-foreground" aria-hidden />
                  <div className="mt-2 font-semibold text-foreground">Not deployed yet</div>
                  <div className="mt-1">
                    {activeStage === 'dev'
                      ? 'Deploy from Sync & Deploy to start a history.'
                      : 'Promote from a previous stage to start a deployment history.'}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {history.map((e, i) => (
                    <DeploymentCard
                      key={`${e.commit}-${i}`}
                      entry={e}
                      isCurrent={e.commit === data?.current}
                      stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
                      busy={busy}
                      onRollback={() => setConfirm(e)}
                      onInspect={() => setInspect(e)}
                    />
                  ))}
                </div>
              )
            ) : section === 'containers' ? (
              members.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  No containers in {STAGE_LABEL[activeStage]}.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {members.map((m) => {
                    const meta = STATUS_META[m.display];
                    const running = m.display === 'running';
                    return (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 rounded-[10px] border border-border bg-background px-4 py-3"
                      >
                        <span className={cn('size-2.5 rounded-full', meta.dot)} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                          {m.name}
                        </span>
                        <span className={cn('text-xs', meta.labelColor)}>{meta.label}</span>
                        {m.replicas > 0 && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Layers className="size-3" aria-hidden />
                            {m.replicas}
                          </span>
                        )}
                        {m.present && (
                          <div className="flex items-center gap-0.5">
                            <Button variant="ghost" size="icon" className="size-8" title="Start"
                              disabled={running}
                              onClick={() => void runContainer('start', m.id, m.name)}>
                              <Play className="size-3.5" aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-8" title="Stop"
                              disabled={!running}
                              onClick={() => void runContainer('stop', m.id, m.name)}>
                              <Square className="size-3.5" aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-8" title="Restart"
                              onClick={() => void runContainer('restart', m.id, m.name)}>
                              <RotateCcw className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )
            ) : section === 'secrets' ? (
              <EmptyTab icon={KeyRound} label="Secrets" />
            ) : section === 'backups' ? (
              <EmptyTab icon={Archive} label="Backups" />
            ) : section === 'firewall' ? (
              <EmptyTab icon={Shield} label="Firewall" />
            ) : section === 'supply' ? (
              <EmptyTab icon={Boxes} label="Supply chain" />
            ) : (
              <EmptyTab icon={Users} label="Access control" />
            )}
          </div>
        </div>
      </div>

      {inspect && (
        <InspectModal
          bp={bp.name}
          stage={activeStage}
          entry={inspect}
          current={currentEntry}
          stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
          currentReplicas={Math.max(1, ...members.map((m) => m.replicas || 0), 0)}
          onClose={() => setInspect(null)}
          onScaled={refresh}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this business process?</AlertDialogTitle>
            <AlertDialogDescription>
              All containers in <span className="font-mono">{bp.name}</span> at{' '}
              {STAGE_LABEL[activeStage]} will be redeployed together to{' '}
              <span className="font-mono">{short(confirm?.source_commit ?? confirm?.commit, 8)}</span> (
              {confirm ? Object.keys(confirm.members ?? {}).length : 0} container(s)).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirm(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void runRollback(confirm)}>
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
