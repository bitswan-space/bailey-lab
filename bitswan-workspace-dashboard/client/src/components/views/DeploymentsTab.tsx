import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowRight,
  Boxes,
  Check,
  CircleSlash,
  Code2,
  Database,
  DatabaseBackup,
  Download,
  HardDrive,
  ExternalLink,
  FileText,
  FlaskConical,
  Folder,
  GitCompare,
  GitMerge,
  Globe,
  History,
  KeyRound,
  Layers,
  LifeBuoy,
  Loader2,
  Lock,
  Play,
  RotateCcw,
  Rocket,
  Scaling,
  Search,
  Shield,
  ShieldCheck,
  Square,
  Terminal,
  Undo2,
  User,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { DiffView } from '@/components/diff/DiffView';
import { FileTree } from '@/components/files/FileTree';
import { SecretsEditor } from '@/components/secrets/SecretsEditor';
import { DisasterRecoveryPanel } from '@/components/disaster-recovery/DisasterRecoveryPanel';
import { DrArchitectureDoc } from '@/components/disaster-recovery/DrArchitectureDoc';
import { SupplyChainPanel } from '@/components/supply-chain/SupplyChainPanel';
import { FirewallPanel } from '@/components/firewall/FirewallPanel';
import { LogsPane } from '@/components/automations/inspect/LogsPane';
import { OverviewPane } from '@/components/automations/inspect/OverviewPane';
import type { ServiceType } from '@/lib/api';
import { promoteBpWithToast } from '@/lib/deployBp';
import { STATUS_META, stateToDisplay, type DisplayStatus } from '@/lib/status';
import {
  api,
  isTransientNetworkError,
  type BpHistory,
  type BpHistoryEntry,
  type ChangedKind,
  type FileTreeNode,
} from '@/lib/api';
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
import { setUrlParams, useUrlEnum, useUrlParam } from '@/lib/urlState';
import type { BusinessProcess, SnapshotStage } from '@/types';
import { StageSnapshotsSection } from '@/components/views/StageSnapshotsSection';

// The same CodeMirror viewer the copy file browser uses — lazy-loaded so the
// editor bundle only lands when someone actually opens a file in Inspect.
const CodeEditor = lazy(() => import('@/components/files/CodeEditor'));
// The Inspect file tree is a read-only snapshot at a commit: no VCS status
// badges, no drag-to-upload. Stable empty/no-op values keep FileTree happy.
const EMPTY_STATUS: Map<string, ChangedKind> = new Map();
const NOOP = () => {};

type StageId = 'dev' | 'staging' | 'production' | 'dr';
const STAGES: { id: StageId; label: string; icon: LucideIcon }[] = [
  { id: 'dev', label: 'Development', icon: Code2 },
  { id: 'staging', label: 'Staging', icon: FlaskConical },
  { id: 'production', label: 'Production', icon: Rocket },
  { id: 'dr', label: 'Disaster Recovery', icon: LifeBuoy },
];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.label]),
);

// DR mirrors Production — it shows Production's deployment data and shares its
// secrets. Map a stage id to the id whose data it displays.
const stageDataId = (id: StageId): StageId => (id === 'dr' ? 'production' : id);
// Stages that actually have their own deployment history (DR has none).
const DATA_STAGES: StageId[] = ['dev', 'staging', 'production'];

type Section =
  | 'history'
  | 'secrets'
  | 'containers'
  | 'backups'
  | 'firewall'
  | 'supply'
  | 'recovery'
  | 'architecture';

const STAGE_IDS = STAGES.map((s) => s.id);
const SECTION_IDS: Section[] = [
  'history',
  'secrets',
  'containers',
  'backups',
  'firewall',
  'supply',
  'recovery',
  'architecture',
];

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
  locked,
  badges,
  onSelect,
}: {
  id: Section;
  active: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  locked?: boolean;
  badges?: { n: number; cls: string; title: string }[];
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
      {locked && <Lock className="size-3 text-muted-foreground" aria-hidden />}
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
      {(badges ?? []).map((b, i) => (
        <span
          key={i}
          title={b.title}
          className={cn('rounded-full px-1.5 text-[10px] font-bold text-white', b.cls)}
        >
          {b.n}
        </span>
      ))}
    </button>
  );
}

// ── Pipeline node ───────────────────────────────────────────────────────────
// Label sits ABOVE the circle; the active stage gets a brand-blue ring and a
// short vertical "tail" dropping toward the card below (wireframe StageNode).
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
      className="relative flex shrink-0 flex-col items-center"
    >
      <span
        className={cn(
          'absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.08em]',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {stage.label}
      </span>
      <span className={cn('rounded-full', active && 'ring-4 ring-primary')}>
        <span
          className={cn(
            'relative flex size-[52px] items-center justify-center rounded-full',
            deployed
              ? 'bg-emerald-500 text-white shadow-sm'
              : 'border-[1.5px] border-dashed border-border text-muted-foreground',
          )}
        >
          <Icon className="size-[22px]" aria-hidden />
          <span className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-background bg-background shadow-sm">
            {deployed ? (
              <Check className="size-3 text-emerald-500" aria-hidden />
            ) : (
              <span className="size-1.5 rounded-full bg-zinc-300" />
            )}
          </span>
        </span>
      </span>
      {active && (
        <span className="absolute top-full h-[22px] w-0.5 bg-primary" aria-hidden />
      )}
    </button>
  );
}

// ── Promote pill (wireframe AggregatePromote) ───────────────────────────────
function PromoteButton({
  canPromote,
  label,
  busy,
  onClick,
}: {
  canPromote: boolean;
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!canPromote || busy}
      onClick={onClick}
      title={canPromote ? `Promote all containers to ${label}` : `Nothing new to promote to ${label}`}
      className={cn(
        'inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold uppercase tracking-[0.03em] transition-colors',
        canPromote
          ? 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
          : 'cursor-not-allowed border-border bg-background text-muted-foreground',
      )}
    >
      Promote
      <ArrowRight className="size-3.5" aria-hidden />
    </button>
  );
}

// ── "Mirrored from Production" banner for DR's read-only sections ───────────
function MirrorBanner() {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
      <Lock className="size-3.5 shrink-0" aria-hidden />
      <span>
        Mirrored from <strong className="text-foreground">Production</strong> · read-only.
        To change this, manage it on the Production stage.
      </span>
    </div>
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

// ── Containers tab ──────────────────────────────────────────────────────────
interface Member {
  id: string;
  name: string;
  present: boolean;
  display: DisplayStatus;
  replicas: number;
  // eslint-disable-next-line no-restricted-syntax -- null = no URL
  url: string | null;
  expose: boolean;
}

const SERVICE_META: Record<ServiceType, { label: string; icon: LucideIcon }> = {
  postgres: { label: 'Postgres', icon: Database },
  minio: { label: 'MinIO', icon: HardDrive },
  couchdb: { label: 'CouchDB', icon: Database },
};

// Map a deployment stage to the realm whose infra services back it (DR mirrors
// production; live-dev shares dev) — matches the gitops service stages.
function realmForStage(stage: StageId): string {
  if (stage === 'dr') return 'production';
  return stage;
}

/** "Stage services" row — links to the real admin consoles of the infra
 *  services (Postgres/MinIO/CouchDB) that are actually enabled+running for this
 *  stage. Renders nothing when none are — no fabricated links. */
function StageServicesRow({ stage }: { stage: StageId }) {
  const [links, setLinks] = useState<{ type: ServiceType; url: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const realm = realmForStage(stage);
    const types: ServiceType[] = ['postgres', 'minio', 'couchdb'];
    Promise.all(
      types.map((t) =>
        api
          .serviceStatus(t, realm)
          .then((s) => ({ t, s }))
          .catch(() => ({ t, s: null })),
      ),
    ).then((rows) => {
      if (!alive) return;
      setLinks(
        rows
          .filter(({ s }) => s && s.enabled && s.running && s.connection_info?.admin_ui)
          .map(({ t, s }) => ({ type: t, url: s!.connection_info!.admin_ui as string })),
      );
    });
    return () => {
      alive = false;
    };
  }, [stage]);

  if (links.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-background px-3.5 py-2.5">
      <span className="mr-1 text-[12px] font-semibold text-foreground">Stage services</span>
      {links.map(({ type, url }) => {
        const meta = SERVICE_META[type];
        const Icon = meta.icon;
        return (
          <a
            key={type}
            href={url}
            target="_blank"
            rel="noreferrer"
            title={`Open ${meta.label} admin in a new tab`}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
          >
            <Icon className="size-3.5" aria-hidden />
            {meta.label}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        );
      })}
    </div>
  );
}

/** One container card: header (status + lifecycle) + inline Logs / Inspect
 *  expanders (single-open), reusing the shared LogsPane + OverviewPane. */
function ContainerCard({
  m,
  onAction,
}: {
  m: Member;
  onAction: (action: 'start' | 'stop' | 'restart', id: string, name: string) => void;
}) {
  const [open, setOpen] = useState<'logs' | 'inspect' | null>(null);
  const meta = STATUS_META[m.display];
  const running = m.display === 'running';
  const KindIcon = m.expose ? Globe : Boxes;
  const toggle = (p: 'logs' | 'inspect') => setOpen((cur) => (cur === p ? null : p));
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <KindIcon className="size-3.5 text-muted-foreground" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-foreground">
          {m.name}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', meta.dot)} aria-hidden />
          <span className={cn('text-xs', meta.labelColor)}>{meta.label}</span>
        </span>
        {m.replicas > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Layers className="size-3" aria-hidden />
            {m.replicas}
          </span>
        )}
        {m.present && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="size-8" title="Restart"
              onClick={() => onAction('restart', m.id, m.name)}>
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
            {running ? (
              <Button variant="ghost" size="icon" className="size-8 text-red-600" title="Stop"
                onClick={() => onAction('stop', m.id, m.name)}>
                <Square className="size-3.5" aria-hidden />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" className="size-8 text-emerald-600" title="Start"
                onClick={() => onAction('start', m.id, m.name)}>
                <Play className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
        )}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <button
          type="button"
          onClick={() => toggle('logs')}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium',
            open === 'logs' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Terminal className="size-3" aria-hidden />
          Logs
        </button>
        <button
          type="button"
          onClick={() => toggle('inspect')}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium',
            open === 'inspect' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Search className="size-3" aria-hidden />
          Inspect
        </button>
      </div>
      {open === 'logs' && (
        <div className="h-64 border-t border-border">
          <LogsPane deploymentId={m.id} active />
        </div>
      )}
      {open === 'inspect' && (
        <div className="border-t border-border px-4 py-3.5">
          <OverviewPane deploymentId={m.id} />
        </div>
      )}
    </div>
  );
}

function ContainersSection({
  members,
  stage,
  stageLabel,
  onAction,
}: {
  members: Member[];
  stage: StageId;
  stageLabel: string;
  onAction: (action: 'start' | 'stop' | 'restart', id: string, name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <StageServicesRow stage={stage} />
      {members.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-muted-foreground">
          No containers in {stageLabel}.
        </div>
      ) : (
        members.map((m) => <ContainerCard key={m.id} m={m} onAction={onAction} />)
      )}
    </div>
  );
}

const BACKUP_EVENT_LABEL: Record<string, string> = {
  created: 'Backup created',
  restored: 'Restored to DR',
  swapped: 'DR ↔ Production swap',
  retention: 'Retention changed',
};

function entryTone(e: BpHistoryEntry, isCurrent: boolean) {
  if (e.source === 'firewall')
    return { dot: 'bg-violet-500', label: 'Firewall change', cls: 'bg-violet-100 text-violet-700' };
  if (e.source === 'backup')
    return {
      dot: 'bg-sky-500',
      label: BACKUP_EVENT_LABEL[e.backup?.action ?? ''] ?? 'Backup',
      cls: 'bg-sky-100 text-sky-700',
    };
  if (e.status === 'rolled-back')
    return { dot: 'bg-amber-500', label: 'Rolled back', cls: 'bg-amber-100 text-amber-700' };
  if (e.status === 'failed')
    return { dot: 'bg-red-500', label: 'Failed', cls: 'bg-red-100 text-red-700' };
  if (isCurrent) return { dot: 'bg-emerald-500', label: 'Current', cls: 'bg-primary/10 text-primary' };
  return { dot: 'bg-emerald-500', label: 'Deployed', cls: 'bg-emerald-100 text-emerald-700' };
}

// ── Inspect modal (per deployment) ──────────────────────────────────────────
type InspectPanel = 'scale' | 'files' | 'diff' | 'secrets' | 'image';
const INSPECT_PANELS: InspectPanel[] = ['scale', 'files', 'diff', 'secrets', 'image'];
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
  const [panel, setPanel] = useUrlEnum(
    'panel',
    INSPECT_PANELS,
    isCurrent ? 'scale' : 'diff',
  );
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const commit = entry.source_commit ?? '';
  // Scale
  const [replicas, setReplicas] = useState(Math.max(1, currentReplicas || 1));
  const [scaling, setScaling] = useState(false);
  // Files — full source tree at the deployed commit + the open file's content.
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded
  const [tree, setTree] = useState<FileTreeNode[] | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  // The open file lives in the URL (?file=…) so the Inspect Files view is
  // deep-linkable; null = nothing open.
  const [openFile, setOpenFile] = useUrlParam('file');
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded
  const [fileContent, setFileContent] = useState<import('@/lib/api').BpFileContent | null>(
    null,
  );
  const [contentLoading, setContentLoading] = useState(false);

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

  // Load the BP's source tree once when the Files tab opens.
  useEffect(() => {
    if (panel !== 'files' || !commit || tree) return;
    let alive = true;
    setTreeLoading(true);
    api
      .bpFileTree(bp, commit)
      .then((r) => alive && setTree(r.entries))
      .catch(() => alive && setTree([]))
      .finally(() => alive && setTreeLoading(false));
    return () => {
      alive = false;
    };
  }, [panel, bp, commit, tree]);

  // Load the open file's content.
  useEffect(() => {
    if (!openFile || !commit) return;
    let alive = true;
    setContentLoading(true);
    setFileContent(null);
    api
      .bpFileContent(bp, commit, openFile)
      .then((r) => alive && setFileContent(r))
      .catch(() => alive && setFileContent(null))
      .finally(() => alive && setContentLoading(false));
    return () => {
      alive = false;
    };
  }, [bp, commit, openFile]);

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
              <div className="flex h-full overflow-hidden">
                <aside className="flex w-[240px] shrink-0 flex-col border-r border-border">
                  <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {bp}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {short(commit, 7)}
                    </span>
                  </div>
                  <div className="flex-1 overflow-auto">
                    {treeLoading ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        Loading…
                      </div>
                    ) : tree && tree.length ? (
                      <FileTree
                        tree={tree}
                        openPath={openFile}
                        statusByPath={EMPTY_STATUS}
                        onOpen={setOpenFile}
                        dragHoverFolder={null}
                        onDragHoverChange={NOOP}
                      />
                    ) : (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        No files.
                      </div>
                    )}
                  </div>
                </aside>
                <div className="flex min-w-0 flex-1 flex-col">
                  {!openFile ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <FileText className="size-6" aria-hidden />
                      Select a file to view its source.
                    </div>
                  ) : contentLoading ? (
                    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
                    </div>
                  ) : fileContent ? (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs">
                        <FileText className="size-3.5 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                          {openFile}
                        </span>
                        {fileContent.truncated && (
                          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            truncated
                          </span>
                        )}
                      </div>
                      <div className="min-h-0 flex-1">
                        <Suspense
                          fallback={
                            <div className="p-8 text-center text-sm text-muted-foreground">
                              Loading editor…
                            </div>
                          }
                        >
                          <CodeEditor
                            value={fileContent.content}
                            path={openFile}
                            readOnly
                            onChange={NOOP}
                            onSave={NOOP}
                          />
                        </Suspense>
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Failed to load file.
                    </div>
                  )}
                </div>
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
  const isFw = entry.source === 'firewall';
  const isBackup = entry.source === 'backup';
  const ver = entry.source_commit ?? entry.commit;
  const members = Object.entries(entry.members ?? {});
  const firstImg = members.find(([, m]) => m.image_id)?.[1]?.image_id;
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-background px-4 py-3.5',
        isCurrent ? 'border-primary ring-[3px] ring-primary/15' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={cn('size-2.5 rounded-full', tone.dot)} aria-hidden />
        <span className="font-mono text-[13px] font-semibold text-foreground">{short(ver)}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', tone.cls)}>
          {isCurrent ? `Current on ${stageLabel}` : tone.label}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">{entry.deployed_at}</span>
        <div className="flex items-center gap-1.5">
          {isBackup ? (
            // Backup-domain audit record — read-only here (swaps/restores are
            // driven from the Backups + Disaster Recovery panels).
            null
          ) : isFw ? (
            // Firewall audit-log entry: restore the rule set to this commit.
            <Button variant="outline" size="sm" disabled={busy} onClick={onRollback}>
              <Undo2 className="size-3.5" aria-hidden />
              Restore rules
            </Button>
          ) : isCurrent ? (
            <>
              <Button variant="outline" size="sm" onClick={onInspect}>
                <Scaling className="size-3.5" aria-hidden />
                Scale
              </Button>
              <Button variant="default" size="sm" onClick={onInspect}>
                <Search className="size-3.5" aria-hidden />
                Inspect
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={onRollback}>
                <Undo2 className="size-3.5" aria-hidden />
                Roll back
              </Button>
              <Button variant="default" size="sm" onClick={onInspect}>
                <Search className="size-3.5" aria-hidden />
                Inspect
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-[12px] text-muted-foreground">
        {entry.deployed_by && (
          <span className="inline-flex items-center gap-1.5">
            <User className="size-3" aria-hidden />
            {entry.deployed_by}
          </span>
        )}
        {isBackup ? (
          <span className="inline-flex items-center gap-1.5">
            <DatabaseBackup className="size-3" aria-hidden />
            {entry.backup?.detail ?? entry.backup?.summary ?? 'backup event'}
          </span>
        ) : isFw ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3" aria-hidden />
              {entry.firewall?.summary ?? 'firewall rules changed'}
            </span>
            <span>
              {entry.firewall?.allowed ?? 0} allowed · {entry.firewall?.denied ?? 0} denied
            </span>
          </>
        ) : (
          <>
            {entry.source && entry.source !== 'deploy' && (
              <span className="inline-flex items-center gap-1.5">
                <GitMerge className="size-3" aria-hidden />
                {entry.source === 'rollback' ? 'rolled back' : `promoted from ${entry.source}`}
              </span>
            )}
            <span>{members.length} container{members.length === 1 ? '' : 's'}</span>
            {firstImg && (
              <span className="font-mono">{firstImg.replace(/^sha256:/, '').slice(0, 12)}</span>
            )}
          </>
        )}
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
  // Stage, section, the open Inspect modal and the rollback confirmation all
  // live in the URL so the exact view is deep-linkable.
  const [activeStage, setActiveStage] = useUrlEnum('stage', STAGE_IDS, 'dev');
  const [section, setSection] = useUrlEnum('section', SECTION_IDS, 'history');
  const [byStage, setByStage] = useState<Record<string, BpHistory | null>>({});
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  // The Inspect modal and rollback confirm are keyed by the entry's commit;
  // the entry itself is resolved from the loaded history below.
  const [inspectCommit, setInspectCommit] = useUrlParam('inspect');
  const [rollbackCommit, setRollbackCommit] = useUrlParam('rollback');

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    Promise.all(
      DATA_STAGES.map((s) =>
        api
          .bpHistory(bp.name, s)
          .then((h) => [s, h] as const)
          .catch(() => [s, null] as const),
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
  const isDr = activeStage === 'dr';
  // Data snapshots are per snapshot-stage (dev/staging/production); DR mirrors
  // production. The ternary narrows StageId → SnapshotStage (drops 'dr').
  const snapshotStage: SnapshotStage = activeStage === 'dr' ? 'production' : activeStage;
  // DR mirrors Production's deployment data.
  const data = byStage[stageDataId(activeStage)] ?? null;
  const history = data?.history ?? [];
  const currentEntry = useMemo(
    () => history.find((e) => e.commit === data?.current) ?? history[0] ?? null,
    [history, data],
  );

  // Resolve the URL-keyed Inspect modal / rollback confirm back to their
  // history entries; the setters write the entry's commit into the URL.
  const inspect = useMemo(
    () => history.find((e) => e.commit === inspectCommit) ?? null,
    [history, inspectCommit],
  );
  const confirm = useMemo(
    () => history.find((e) => e.commit === rollbackCommit) ?? null,
    [history, rollbackCommit],
  );
  const setInspect = useCallback(
    // eslint-disable-next-line no-restricted-syntax -- null = close modal
    (e: BpHistoryEntry | null) => setInspectCommit(e ? e.commit : null),
    [setInspectCommit],
  );
  const setConfirm = useCallback(
    // eslint-disable-next-line no-restricted-syntax -- null = close dialog
    (e: BpHistoryEntry | null) => setRollbackCommit(e ? e.commit : null),
    [setRollbackCommit],
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
      const isFw = entry.source === 'firewall';
      const ver = short(entry.source_commit ?? entry.commit, 8);
      const what = isFw ? 'firewall rules' : bp.name;
      setBusy(true);
      const work = api.bpRollback(
        bp.name,
        activeStage,
        entry.commit,
        isFw ? 'firewall' : 'deploy',
      );
      toast.promise(work, {
        loading: `Rolling ${what} back to ${ver}…`,
        success: `${what} rolled back to ${ver}`,
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
    if (!currentEntry)
      return { label: 'Not deployed yet', color: 'text-muted-foreground', dot: 'bg-zinc-400', ring: 'ring-zinc-400/10' };
    if (failing > 0)
      return { label: `${failing} service${failing === 1 ? '' : 's'} not running`, color: 'text-red-600', dot: 'bg-red-500', ring: 'ring-red-500/10' };
    return { label: 'Healthy', color: 'text-emerald-600', dot: 'bg-emerald-500', ring: 'ring-emerald-500/10' };
  }, [members, currentEntry]);

  // "{N} containers promote together" — the BP's container count, stable across
  // stages (max members seen on any stage's current deployment).
  const bpContainerCount = useMemo(() => {
    let max = 0;
    for (const s of DATA_STAGES) {
      const h = byStage[s];
      const cur = h?.history.find((e) => e.commit === h.current) ?? h?.history[0];
      if (cur) max = Math.max(max, Object.keys(cur.members ?? {}).length);
    }
    return max;
  }, [byStage]);

  // Critical/high CVE badge on the Supply chain tab (active, non-waived) for the
  // current stage — one fetch per stage view.
  const [supplyBadges, setSupplyBadges] = useState<
    { n: number; cls: string; title: string }[]
  >([]);
  useEffect(() => {
    let alive = true;
    api
      .supplyChain(bp.name, isDr ? 'production' : activeStage)
      .then((r) => {
        if (!alive) return;
        const waived = new Set((r.waivers ?? []).map((w) => `${w.package}|${w.cve}`));
        let crit = 0;
        let high = 0;
        for (const p of r.packages ?? [])
          for (const c of p.cves) {
            if (waived.has(`${p.name}|${c.id}`)) continue;
            if (c.severity === 'critical') crit += 1;
            else if (c.severity === 'high') high += 1;
          }
        const b: { n: number; cls: string; title: string }[] = [];
        if (crit) b.push({ n: crit, cls: 'bg-red-600', title: `${crit} critical CVEs` });
        if (high) b.push({ n: high, cls: 'bg-orange-600', title: `${high} high CVEs` });
        setSupplyBadges(b);
      })
      .catch(() => alive && setSupplyBadges([]));
    return () => {
      alive = false;
    };
  }, [bp.name, activeStage, isDr, reloadKey]);

  // Firewall tab badge: count of blocked/observed hosts awaiting review.
  const [firewallBadge, setFirewallBadge] = useState<
    { n: number; cls: string; title: string }[]
  >([]);
  useEffect(() => {
    let alive = true;
    api
      .firewall(bp.name, isDr ? 'production' : activeStage)
      .then((r) => {
        if (!alive) return;
        const n = (r.attempts ?? []).length;
        setFirewallBadge(n ? [{ n, cls: 'bg-red-600', title: `${n} unreviewed blocked attempts` }] : []);
      })
      .catch(() => alive && setFirewallBadge([]));
    return () => {
      alive = false;
    };
  }, [bp.name, activeStage, isDr, reloadKey]);

  // DR's tabs: its own Recovery-tests + Containers, then a "Mirrored from
  // Production" group (read-only) for the data it shares. Other stages keep the
  // full set.
  const SECTIONS: {
    id: Section;
    icon: LucideIcon;
    label: string;
    count?: number;
    locked?: boolean;
    badges?: { n: number; cls: string; title: string }[];
  }[] = isDr
    ? [
        { id: 'recovery', icon: LifeBuoy, label: 'Recovery tests' },
        { id: 'architecture', icon: FileText, label: 'How it works' },
        { id: 'containers', icon: Boxes, label: 'Containers', count: members.length },
        { id: 'history', icon: History, label: 'Deployment history', count: history.length, locked: true },
        { id: 'secrets', icon: KeyRound, label: 'Secrets', locked: true },
        { id: 'firewall', icon: Shield, label: 'Firewall', locked: true, badges: firewallBadge },
        { id: 'supply', icon: Boxes, label: 'Supply chain', locked: true, badges: supplyBadges },
      ]
    : [
        { id: 'history', icon: History, label: 'Deployment history', count: history.length },
        { id: 'secrets', icon: KeyRound, label: 'Secrets' },
        { id: 'containers', icon: Boxes, label: 'Containers', count: members.length },
        { id: 'backups', icon: Archive, label: 'Backups' },
        { id: 'firewall', icon: Shield, label: 'Firewall', badges: firewallBadge },
        { id: 'supply', icon: Boxes, label: 'Supply chain', badges: supplyBadges },
      ];
  // The section that's actually shown — falls back to the stage's first tab when
  // the URL section isn't valid here (e.g. 'backups' isn't a DR tab, 'recovery'
  // only exists on DR).
  const visibleSection: Section = SECTIONS.some((s) => s.id === section)
    ? section
    : (SECTIONS[0]?.id ?? 'history');

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="flex flex-col gap-5 px-6 py-6">
        {/* Section header */}
        <div className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Automation
            </div>
            <div className="text-[18px] font-semibold tracking-tight text-foreground">
              {bp.name}
            </div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {bpContainerCount} container{bpContainerCount === 1 ? '' : 's'} promote together.
              Pick a stage to manage its deployment, secrets and history.
            </div>
          </div>
        </div>

        {/* Stage pipeline — a bare stepper above the card (wireframe) */}
        <div className="flex items-center gap-2 px-11 pt-7">
          {STAGES.map((s, i) => {
            const sHist = byStage[stageDataId(s.id)];
            const deployed = !!sHist && sHist.history.length > 0;
            const next = STAGES[i + 1];
            const srcCur =
              sHist?.history.find((h) => h.commit === sHist.current)?.source_commit ?? null;
            const tgtCur = next
              ? (byStage[next.id]?.history.find(
                  (h) => h.commit === byStage[next.id]?.current,
                )?.source_commit ?? null)
              : null;
            const canPromote = deployed && !!next && srcCur !== tgtCur;
            return (
              <Fragment key={s.id}>
                <StageNode
                  stage={s}
                  deployed={deployed}
                  active={s.id === activeStage}
                  onClick={() => setActiveStage(s.id)}
                />
                {next && (
                  <>
                    <div className="h-0.5 flex-1 bg-border" aria-hidden />
                    <div className="shrink-0">
                      {next.id === 'dr' ? (
                        // DR isn't promoted into — it's seeded by restoring
                        // Production's data. The pill just selects the DR stage.
                        <button
                          type="button"
                          onClick={() => setActiveStage('dr')}
                          title="Disaster Recovery — restore & verify Production's data"
                          className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                        >
                          <DatabaseBackup className="size-3.5" aria-hidden />
                          Restore
                        </button>
                      ) : (
                        <PromoteButton
                          canPromote={canPromote}
                          label={next.label}
                          busy={busy}
                          onClick={() => void runPromote(next.id as 'staging' | 'production')}
                        />
                      )}
                    </div>
                    <div className="h-0.5 flex-1 bg-border" aria-hidden />
                  </>
                )}
              </Fragment>
            );
          })}
        </div>

        {/* Rich stage card */}
        <div className="overflow-hidden rounded-[14px] border border-border bg-background shadow-sm">
          {/* Stage header */}
          <div className="flex flex-wrap items-start gap-4 border-b border-border px-[22px] py-[18px]">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className={cn('size-3 rounded-full ring-[5px]', friendly.dot, friendly.ring)} aria-hidden />
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
            <div className="border-b border-border px-[22px] py-4">
              <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Open app
              </div>
              <div className="flex flex-wrap gap-2.5">
                {frontends.map((f) => {
                  const deployed = f.display === 'running';
                  const inner = (
                    <>
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg',
                          deployed ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <Globe className="size-[18px]" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate font-mono text-[13px] font-semibold',
                            deployed ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {f.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {deployed && f.url ? f.url.replace('https://', '') : 'Not deployed'}
                        </span>
                      </span>
                      {deployed && f.url ? (
                        <ExternalLink className="size-3.5 shrink-0 text-primary" aria-hidden />
                      ) : (
                        <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      )}
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
          <div className="flex flex-wrap items-center gap-4 border-b border-border px-[22px] pt-3.5">
            {SECTIONS.filter((s) => !s.locked).map((s) => (
              <SectionTab key={s.id} {...s} active={visibleSection === s.id} onSelect={setSection} />
            ))}
            {isDr && SECTIONS.some((s) => s.locked) && (
              <>
                <span className="h-[22px] w-px self-center bg-border" aria-hidden />
                <span className="inline-flex items-center gap-1.5 self-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  Mirrored from Production
                </span>
              </>
            )}
            {SECTIONS.filter((s) => s.locked).map((s) => (
              <SectionTab key={s.id} {...s} active={visibleSection === s.id} onSelect={setSection} />
            ))}
          </div>

          {/* Section content */}
          <div className="bg-muted/30 px-[22px] py-5">
            {isDr && (visibleSection === 'history' || visibleSection === 'secrets' || visibleSection === 'firewall' || visibleSection === 'supply') && (
              <MirrorBanner />
            )}
            {/* The architecture explainer is static — never gate it on
                deployment data (a never-deployed DR BP would hang on Loading). */}
            {visibleSection === 'architecture' ? (
              <DrArchitectureDoc />
            ) : !loaded ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </div>
            ) : visibleSection === 'recovery' ? (
              <DisasterRecoveryPanel bp={bp.name} frontends={frontends} />
            ) : visibleSection === 'history' ? (
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
            ) : visibleSection === 'containers' ? (
              <ContainersSection
                members={members}
                stage={activeStage}
                stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
                onAction={runContainer}
              />
            ) : visibleSection === 'secrets' ? (
              isDr ? (
                // Mirrored from Production — read-only.
                <div className="pointer-events-none opacity-90">
                  <SecretsEditor bp={bp.name} stage="production" stageLabel="Production" />
                </div>
              ) : (
                <SecretsEditor
                  bp={bp.name}
                  stage={activeStage}
                  stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
                />
              )
            ) : visibleSection === 'backups' ? (
              <StageSnapshotsSection bp={bp} stage={snapshotStage} />
            ) : visibleSection === 'firewall' ? (
              <FirewallPanel
                bp={bp.name}
                stage={isDr ? 'production' : activeStage}
                stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
                prevStage={
                  activeStage === 'staging' ? 'dev' : activeStage === 'production' ? 'staging' : undefined
                }
                readOnly={isDr}
                onChange={refresh}
              />
            ) : (
              <SupplyChainPanel
                bp={bp.name}
                stage={isDr ? 'production' : activeStage}
                stageLabel={STAGE_LABEL[activeStage] ?? activeStage}
                readOnly
              />
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
          onClose={() => setUrlParams({ inspect: null, panel: null, file: null })}
          onScaled={refresh}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.source === 'firewall'
                ? 'Restore firewall rules to this version?'
                : 'Roll back this business process?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.source === 'firewall' ? (
                <>
                  The egress allow-list for <span className="font-mono">{bp.name}</span> at{' '}
                  {STAGE_LABEL[activeStage]} will be restored to{' '}
                  <span className="font-mono">{short(confirm?.commit, 8)}</span> (
                  {confirm?.firewall?.allowed ?? 0} allowed · {confirm?.firewall?.denied ?? 0} denied)
                  and the running gateway reloaded. The restore is itself recorded in the audit log.
                </>
              ) : (
                <>
                  All containers in <span className="font-mono">{bp.name}</span> at{' '}
                  {STAGE_LABEL[activeStage]} will be redeployed together to{' '}
                  <span className="font-mono">{short(confirm?.source_commit ?? confirm?.commit, 8)}</span> (
                  {confirm ? Object.keys(confirm.members ?? {}).length : 0} container(s)).
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirm(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void runRollback(confirm)}>
              {confirm?.source === 'firewall' ? 'Restore rules' : 'Roll back'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
