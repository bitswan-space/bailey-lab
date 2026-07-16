import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
  Eye,
  EyeOff,
  FileText,
  FlaskConical,
  Folder,
  Gavel,
  GitCompare,
  GitMerge,
  Globe,
  History,
  KeyRound,
  Layers,
  MemoryStick,
  Minus,
  Moon,
  Power,
  LifeBuoy,
  Loader2,
  Lock,
  Play,
  Plus,
  RotateCcw,
  Rocket,
  Scaling,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  Square,
  Terminal,
  Undo2,
  User,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from '@/lib/notify';
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
import type { ServiceType, StagingGate, StagingLogEntry, StagingSignoff } from '@/lib/api';
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
import { ObjectBrowser } from '@/components/data-explorer/ObjectBrowser';
import { SqlExplorer } from '@/components/data-explorer/SqlExplorer';

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

/** The content-hash tag of a baked image (`repo/name:sha<tree-hash>` → the
 *  `sha…` part), which is deterministic from the source content. */
function imageTag(img?: string | null): string | null {
  if (!img) return null;
  const i = img.lastIndexOf(':');
  return i >= 0 ? img.slice(i + 1) : img;
}

/**
 * A stable fingerprint of the content a stage is actually RUNNING: the sorted
 * set of baked image content-hashes across the BP's members on its current
 * deploy. This — not `source_commit` — is the real "version" to compare for
 * promotability: the dev stage bakes the live workspace tree, which can be
 * ahead of its committed git HEAD, so `source_commit` lags the deployed
 * content and would hide a genuinely-newer dev build from Promote. Walks back
 * from the current entry to the most recent one that lists images (firewall /
 * backup events carry none). Returns null when nothing is deployed.
 */
function deployedContentKey(hist?: BpHistory | null): string | null {
  if (!hist || hist.history.length === 0) return null;
  const curIdx = Math.max(
    0,
    hist.history.findIndex((h) => h.commit === hist.current),
  );
  for (let i = curIdx; i < hist.history.length; i++) {
    const members = hist.history[i]?.members;
    const tags = members
      ? Object.values(members)
          .map((m) => imageTag(m.image) ?? m.image_id ?? null)
          .filter((x): x is string => !!x)
      : [];
    if (tags.length) return tags.slice().sort().join('|');
  }
  return null;
}
// Stages that actually have their own deployment history (DR has none).
const DATA_STAGES: StageId[] = ['dev', 'staging', 'production'];

type Section =
  | 'history'
  | 'secrets'
  | 'containers'
  | 'backups'
  | 'firewall'
  | 'supply'
  | 'audits'
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
  'audits',
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
    </button>
  );
}

// ── Promote pill (wireframe AggregatePromote) ───────────────────────────────
function PromoteButton({
  canPromote,
  label,
  busy,
  onClick,
  blockedTitle,
}: {
  canPromote: boolean;
  label: string;
  busy: boolean;
  onClick: () => void;
  blockedTitle?: string;
}) {
  return (
    <button
      type="button"
      disabled={!canPromote || busy}
      onClick={onClick}
      title={
        canPromote
          ? `Promote all containers to ${label}`
          : blockedTitle || `Nothing new to promote to ${label}`
      }
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

// ── Freeze staging + production-promotion audit gate ───────────────────────

/** Whether a role may freeze staging, edit the audit policy, and sign off. */
function isAuditor(role: string | null): boolean {
  return role === 'admin' || role === 'auditor';
}

/** Freeze / Frozen pill hanging off the Staging node, with a quarter-circle arc
 *  (arrowhead curling toward the promote-to-production side) linking the node to
 *  the pill — mirrors the wireframe. Absolutely positioned so its origin sits at
 *  the node's centre; the parent staging cell is `relative`. Freezing (admin/
 *  auditor only) locks the staging image for audit and closes dev→staging. */
function FreezeControl({
  gate,
  canManage,
  busy,
  onToggle,
}: {
  // eslint-disable-next-line no-restricted-syntax -- null = gate not loaded yet
  gate: StagingGate | null;
  canManage: boolean;
  busy: boolean;
  onToggle: (frozen: boolean) => void;
}) {
  if (!gate) return null;
  const frozen = gate.frozen;
  const stroke = frozen ? '#0284c7' : '#a1a1aa';
  const R = 34; // arc radius — same centre as the staging circle, just outside it
  const p = R * 0.707; // 45° offset
  const title = frozen
    ? `Staging frozen${gate.frozen_by ? ` by ${gate.frozen_by}` : ''}${gate.frozen_at ? ` · ${gate.frozen_at}` : ''}${canManage ? ' — click to unfreeze (re-opens promotion from Development)' : ''}`
    : canManage
      ? 'Freeze staging — locks the image for audit and enables promotion to Production'
      : 'Only admins and auditors can freeze staging';
  return (
    <div className="pointer-events-none absolute left-1/2 top-[26px] size-0" style={{ zIndex: 2 }}>
      {/* Quarter circle hugging the node's bottom (7:30 → 4:30) with an arrowhead
          curling toward the promote-to-prod side. */}
      <svg width="1" height="1" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} aria-hidden>
        <path
          d={`M ${-p} ${p} A ${R} ${R} 0 0 0 ${p} ${p}`}
          fill="none"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d={`M ${p - 1.7} ${p + 6.8} L ${p} ${p} L ${p - 6.8} ${p + 1.7}`}
          fill="none"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <button
        type="button"
        disabled={!canManage || busy}
        onClick={() => onToggle(!frozen)}
        title={title}
        style={{ top: R + 8, left: 0 }}
        className={cn(
          'pointer-events-auto absolute flex h-[26px] -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[10px] font-bold uppercase tracking-[0.05em] shadow-sm transition-colors',
          frozen
            ? 'border-sky-300 bg-sky-50 text-sky-700'
            : 'border-border bg-background text-muted-foreground',
          canManage && !busy ? 'cursor-pointer hover:border-sky-300 hover:text-sky-700' : 'cursor-not-allowed',
        )}
      >
        <Snowflake className="size-3" aria-hidden />
        {frozen ? 'Unfreeze' : 'Freeze'}
      </button>
    </div>
  );
}

/** Dashed "locked" pill that REPLACES a promote button — the freeze toggle
 *  decides which stage can be promoted, so the button is removed (not merely
 *  disabled) to make that obvious. */
function LockedStep({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-dashed border-border bg-muted/40 px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground"
    >
      <Lock className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** "Audits N/M" step in the pipeline BETWEEN Staging and the promote-to-prod
 *  button (its own node, with connector lines on each side — wireframe). Opens
 *  the Audits sub-tab. Neutral when nothing is on staging, green when the policy
 *  is met, amber when sign-offs are still outstanding. */
function AuditsBadge({ gate, onClick }: { gate: StagingGate; onClick: () => void }) {
  const hasStaging = !!gate.current_sha;
  const met = gate.audits_met && gate.rejections === 0;
  const cls = !hasStaging
    ? 'border-border bg-background text-muted-foreground'
    : met
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : 'border-amber-300 bg-amber-50 text-amber-700';
  return (
    <button
      type="button"
      onClick={hasStaging ? onClick : undefined}
      disabled={!hasStaging}
      title={
        !hasStaging
          ? 'Nothing deployed to Staging yet'
          : `${gate.approvals} of ${gate.required} required audit sign-offs on the staging image — click to review or add yours`
      }
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold uppercase tracking-[0.03em] transition-colors',
        cls,
        hasStaging ? 'cursor-pointer' : 'cursor-not-allowed',
      )}
    >
      <Gavel className="size-3.5" aria-hidden />
      Audits {gate.approvals}/{gate.required}
    </button>
  );
}

/** One freeze / unfreeze / policy-change event in the gate's governance log. */
function LogRow({ e }: { e: StagingLogEntry }) {
  const icon =
    e.event === 'policy' ? (
      <Gavel className="size-3.5" aria-hidden />
    ) : (
      <Snowflake className="size-3.5" aria-hidden />
    );
  const tone = e.event === 'policy' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700';
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn('mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full', tone)}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-foreground">{e.who}</span>
          {e.role ? <span className="text-[12px] text-muted-foreground">· {e.role}</span> : null}
          <span className="text-[12px] text-muted-foreground">· {e.at}</span>
        </div>
        <div className="mt-0.5 text-[13px] text-foreground">{e.detail}</div>
      </div>
    </div>
  );
}

/** One audit sign-off (approve / request changes) on the staging image. */
function SignoffRow({ a }: { a: StagingSignoff }) {
  const ok = a.verdict === 'approve';
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn(
          'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
        )}
        aria-hidden
      >
        {ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-foreground">{a.who}</span>
          {a.role ? <span className="text-[12px] text-muted-foreground">· {a.role}</span> : null}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
            )}
          >
            {ok ? 'Approved' : 'Changes requested'}
          </span>
          <span className="text-[12px] text-muted-foreground">· {a.at}</span>
        </div>
        {a.note ? (
          <div className="mt-1 rounded-md border-l-2 border-border bg-muted/40 px-2.5 py-1.5 text-[12px] text-muted-foreground">
            {a.note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The Audits sub-tab: audit policy (editable by admin/auditor), freeze status,
 *  the audit log (from bitswan.yaml), and the sign-off form. */
function AuditsPanel({
  bp,
  gate,
  role,
  meEmail,
  onChange,
}: {
  bp: string;
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  gate: StagingGate | null;
  // eslint-disable-next-line no-restricted-syntax -- null = unknown role
  role: string | null;
  meEmail: string;
  onChange: () => void;
}) {
  const canAudit = isAuditor(role);
  const roleKnown = role !== null;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editPolicy, setEditPolicy] = useState(false);
  const [draft, setDraft] = useState(gate?.required ?? 1);
  // The workspace's auditor/admin roster — shown to a member so they know who to
  // ask. null = loading; [] with error flag = load failed (honest, not faked).
  // eslint-disable-next-line no-restricted-syntax -- null = loading
  const [auditors, setAuditors] = useState<{ email: string; role: string }[] | null>(null);
  const [auditorsError, setAuditorsError] = useState(false);
  useEffect(() => {
    setDraft(gate?.required ?? 1);
  }, [gate?.required]);
  useEffect(() => {
    // Only a non-auditor needs the "ask one of these people" list.
    if (!roleKnown || canAudit) return;
    let alive = true;
    api
      .workspaceAuditors()
      .then((r) => {
        if (alive) setAuditors(r.users ?? []);
      })
      .catch(() => {
        if (alive) {
          setAuditors([]);
          setAuditorsError(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [roleKnown, canAudit]);

  if (!gate) {
    return (
      <div className="px-3 py-12 text-center text-[13px] text-muted-foreground">Loading…</div>
    );
  }

  // My most-recent sign-off on the frozen image (signoffs are newest-first), so
  // I can see my current verdict and change it — reject → approve or back.
  const myLatest = meEmail ? gate.signoffs.find((a) => a.who === meEmail) : undefined;

  const doAudit = async (verdict: 'approve' | 'reject') => {
    setBusy(true);
    const work = api.recordAudit(bp, verdict, note.trim() || undefined);
    toast.promise(work, {
      loading: verdict === 'approve' ? 'Recording approval…' : 'Requesting changes…',
      success: verdict === 'approve' ? 'Audit approved' : 'Changes requested',
      error: (e: unknown) => `Audit failed: ${String(e)}`,
    });
    try {
      await work;
      setNote('');
      onChange();
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    setBusy(true);
    const work = api.setAuditPolicy(bp, draft);
    toast.promise(work, {
      loading: 'Saving audit policy…',
      success: 'Audit policy saved',
      error: (e: unknown) => `Save failed: ${String(e)}`,
    });
    try {
      await work;
      setEditPolicy(false);
      onChange();
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-1 py-1">
      {/* Policy + freeze status + sign-off are auditor/admin surface. A member
          sees only the audit log plus the "ask an auditor" coverage below. */}
      {canAudit ? (
      <>
      {/* Audit policy */}
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {gate.audits_met && gate.rejections === 0 ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            )}
            <div className="text-[13px] text-foreground">
              <strong>Audit policy:</strong> this image must be signed off by {gate.required}{' '}
              auditor{gate.required === 1 ? '' : 's'} before Staging can be promoted to Production.{' '}
              <strong>{gate.approvals}</strong> of {gate.required} complete.
            </div>
          </div>
          {!editPolicy ? (
            <button
              type="button"
              onClick={() => setEditPolicy(true)}
              className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Edit policy
            </button>
          ) : null}
        </div>
        {editPolicy ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-foreground">Audits required</span>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                aria-label="decrease"
                onClick={() => setDraft((n) => Math.max(1, n - 1))}
                className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              >
                <Minus className="size-3" aria-hidden />
              </button>
              <span className="w-6 text-center text-[13px] font-semibold text-foreground">
                {draft}
              </span>
              <button
                type="button"
                aria-label="increase"
                onClick={() => setDraft((n) => Math.min(5, n + 1))}
                className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              >
                <Plus className="size-3" aria-hidden />
              </button>
            </div>
            <span className="text-[11px] text-muted-foreground">at least 1 · up to 5</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditPolicy(false);
                  setDraft(gate.required);
                }}
                className="rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void savePolicy()}
                className="rounded-md border border-primary bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Save policy
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Freeze status */}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {gate.frozen ? (
          <>
            <Snowflake className="size-3.5 text-sky-600" aria-hidden />
            <span>
              Staging is <strong className="text-foreground">frozen</strong>
              {gate.frozen_by ? ` by ${gate.frozen_by}` : ''}
              {gate.frozen_at ? ` · ${gate.frozen_at}` : ''}. Audits below apply to the frozen
              image
              {gate.frozen_sha ? ` (${gate.frozen_sha.slice(0, 12)})` : ''}.
            </span>
          </>
        ) : (
          <>
            <Snowflake className="size-3.5" aria-hidden />
            <span>
              Staging is not frozen. Freeze it (on the Staging node) to lock the image and collect
              audits before promoting to Production.
            </span>
          </>
        )}
      </div>
      </>
      ) : null}

      {/* Audit sign-offs on the staging image (from the content-hash-keyed
          store — these travel with the image into Production). */}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Audit sign-offs {gate.frozen_sha ? `· image ${gate.frozen_sha.slice(0, 12)}` : ''}
        </div>
        {gate.signoffs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] text-muted-foreground">
            No sign-offs on this image yet.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-background px-3.5">
            {gate.signoffs.map((a) => (
              <SignoffRow key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>

      {/* Freeze & policy governance history. */}
      {gate.log.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Freeze &amp; policy history
          </div>
          <div className="rounded-lg border border-border bg-background px-3.5">
            {gate.log.map((e) => (
              <LogRow key={e.id} e={e} />
            ))}
          </div>
        </div>
      )}

      {/* Action area: member coverage / freeze-first / sign-off form */}
      {!roleKnown ? null : !canAudit ? (
        // A normal member: everything but the log is covered by an explainer +
        // the list of auditors/admins they can ask.
        <div className="order-first rounded-lg border border-border bg-muted/30 px-3.5 py-3">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="text-[13px] text-foreground">
              Only <strong>admins and auditors</strong> can freeze staging, set the audit policy and
              sign off. You can promote to Staging, but promoting to Production must be done by an
              auditor. Ask one of them to review this image:
            </div>
          </div>
          <div className="mt-2.5 pl-6">
            {auditors === null ? (
              <div className="text-[12px] text-muted-foreground">Loading auditors…</div>
            ) : auditorsError ? (
              <div className="text-[12px] text-amber-700">
                Couldn’t load the auditor list. Please try again.
              </div>
            ) : auditors.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">
                No auditors or admins are configured in this workspace yet.
              </div>
            ) : (
              <ul className="space-y-1">
                {auditors.map((a) => (
                  <li key={a.email} className="flex items-center gap-2 text-[13px] text-foreground">
                    <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{a.email}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {a.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : !gate.frozen ? (
        // Auditor/admin, but nothing to audit yet — must freeze first.
        <div className="order-first flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3.5 py-3 text-[13px] text-foreground">
          <Snowflake className="size-4 shrink-0 text-sky-600" aria-hidden />
          <span>
            You must <strong>freeze staging</strong> before auditing — freeze it on the Staging node
            above to lock the image, then sign off here.
          </span>
        </div>
      ) : (
        <div className="order-first rounded-lg border border-border bg-muted/30 px-3.5 py-3">
          {myLatest ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
              <span>Your current sign-off:</span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  myLatest.verdict === 'approve'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-red-100 text-red-700',
                )}
              >
                {myLatest.verdict === 'approve' ? (
                  <Check className="size-3" aria-hidden />
                ) : (
                  <X className="size-3" aria-hidden />
                )}
                {myLatest.verdict === 'approve' ? 'Approved' : 'Changes requested'}
              </span>
              <span>— you can change it below.</span>
            </div>
          ) : null}
          <div className="mb-2 text-[13px] font-semibold text-foreground">
            {myLatest ? 'Update your audit' : 'Add your audit'}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Audit note — what did you review? (supports multiple lines)"
            className="mb-2 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-primary"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void doAudit('approve')}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100"
            >
              <Check className="size-3.5" aria-hidden />
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void doAudit('reject')}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-red-700 hover:bg-red-100"
            >
              <X className="size-3.5" aria-hidden />
              Request changes
            </button>
          </div>
        </div>
      )}
    </div>
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

// Human byte size (binary units — what `free -h` shows).
function fmtBytes(n: number): string {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${u[i]}`;
}

interface Member {
  id: string;
  name: string;
  present: boolean;
  display: DisplayStatus;
  replicas: number;
  // eslint-disable-next-line no-restricted-syntax -- null = no URL
  url: string | null;
  expose: boolean;
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable
  memUsageBytes: number | null;
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable
  memReservationMB: number | null;
  memOver: boolean;
  // Why this member is asleep — 'memory-pressure' | 'manual' — or null when it
  // has a running container. Drives the stage's "Asleep" attribution.
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable
  asleepReason: string | null;
}

const SERVICE_META: Record<ServiceType, { label: string; icon: LucideIcon }> = {
  postgres: { label: 'Postgres', icon: Database },
  garage: { label: 'Object Storage', icon: HardDrive },
  couchdb: { label: 'CouchDB', icon: Database },
};

// Map a deployment stage to the realm whose infra services back it (DR mirrors
// production; live-dev shares dev) — matches the gitops service stages.
function realmForStage(stage: StageId): string {
  if (stage === 'dr') return 'production';
  return stage;
}

/** "Stage services" row — links to the real admin consoles of the infra
 *  services that are actually enabled+running for this stage. Renders nothing
 *  when none are — no fabricated links. Since the in-dashboard data explorers
 *  replaced the service consoles, the Automation tab narrows this to CouchDB
 *  via `only` (pgAdmin and the MinIO console are gone — Garage is headless;
 *  the explorers are the data UI). */
function StageServicesRow({ stage, only }: { stage: StageId; only?: ServiceType[] }) {
  const [links, setLinks] = useState<{ type: ServiceType; url: string }[]>([]);
  useEffect(() => {
    let alive = true;
    const realm = realmForStage(stage);
    const types: ServiceType[] = only ?? ['postgres', 'garage', 'couchdb'];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `only` callers pass literals
  }, [stage, only?.join(',')]);

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
    <div
      data-testid="container-card"
      data-container-status={m.display}
      className="overflow-hidden rounded-[10px] border border-border bg-background"
    >
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
        {m.memReservationMB != null && (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[11px]',
              m.memOver ? 'font-semibold text-red-600' : 'text-muted-foreground',
            )}
            title={
              m.memOver
                ? 'Memory usage exceeds this container’s reservation'
                : 'Memory usage / reserved'
            }
          >
            <MemoryStick className="size-3" aria-hidden />
            {m.memUsageBytes != null ? fmtBytes(m.memUsageBytes) : '—'} / {m.memReservationMB} MB
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
  bp,
  onAction,
  onRefresh,
}: {
  members: Member[];
  stage: StageId;
  stageLabel: string;
  bp: string;
  onAction: (action: 'start' | 'stop' | 'restart', id: string, name: string) => void;
  onRefresh: () => void;
}) {
  // Sub-tab: the stage's containers vs its data (read-only explorers scoped
  // to this BP's per-stage bucket/database). Deep-linked via `?csub=`.
  const [csub] = useUrlEnum('csub', ['automation', 'objects', 'sql'] as const, 'automation');
  const switchSub = (v: 'automation' | 'objects' | 'sql') =>
    setUrlParams({
      csub: v === 'automation' ? null : v,
      // Clear the explorers' deep-link params when leaving them.
      table: null,
      page: null,
      sort: null,
      dir: null,
      prefix: null,
      obj: null,
    });
  // DR mirrors production's data; live explorer scope is always a real realm.
  const dataScope = {
    bp,
    stage: (stage === 'dr' ? 'production' : stage) as 'dev' | 'staging' | 'production',
  };
  const [busy, setBusy] = useState(false);
  // "Running" is the live container state, NOT whether a deploy record exists —
  // an asleep stage still has its records (present=true) but no running container.
  const isUp = (m: Member) =>
    m.display === 'running' ||
    m.display === 'restarting' ||
    m.display === 'building' ||
    m.display === 'deployed';
  const anyRunning = members.some(isUp);
  const asleep = members.length > 0 && members.every((m) => !isUp(m));
  // Why it's asleep (memory-pressure | manual) — gitops stamps it on the members,
  // so the message can attribute the sleep instead of a bare "asleep".
  const asleepReason = members.map((m) => m.asleepReason).find(Boolean) ?? null;
  // Sleep/Wake apply to the promoted stages (their context is the raw BP); DR is
  // a standby slot managed via the backup swap, so no power toggle there.
  const canPower = stage === 'dev' || stage === 'staging' || stage === 'production';

  const power = async (action: 'sleep' | 'wake') => {
    setBusy(true);
    const work = api.stagePower(action, bp, stage, null);
    toast.promise(work, {
      loading: action === 'sleep' ? `Putting ${stageLabel} to sleep…` : `Waking ${stageLabel}…`,
      success: action === 'sleep' ? `${stageLabel} put to sleep` : `${stageLabel} woken`,
      error: (e: unknown) => `Failed to ${action} ${stageLabel}: ${String(e)}`,
    });
    try {
      await work;
      onRefresh();
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Automation | Object Storage | SQL — replaces the old full
          "Stage services" console-link row. */}
      <div className="flex items-center gap-4 border-b border-border px-1">
        <ContainersSubTab active={csub === 'automation'} onClick={() => switchSub('automation')} label="Automation" />
        <ContainersSubTab active={csub === 'objects'} onClick={() => switchSub('objects')} label="Object Storage" />
        <ContainersSubTab active={csub === 'sql'} onClick={() => switchSub('sql')} label="SQL" />
      </div>

      {csub !== 'automation' ? (
        <>
          {stage === 'dr' && <MirrorBanner />}
          <div className="flex h-[560px] flex-col overflow-hidden rounded-[10px] border border-border bg-background">
            {csub === 'objects' ? (
              <ObjectBrowser scope={dataScope} active />
            ) : (
              <SqlExplorer scope={dataScope} active />
            )}
          </div>
        </>
      ) : (
        <>
      {canPower && (members.length > 0 || asleep) && (
        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-muted/40 px-4 py-2.5">
          <MemoryStick className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-[12.5px] text-muted-foreground">
            {asleep
              ? asleepReason === 'manual'
                ? 'Asleep — put to sleep manually. Wakes on access, or wake now.'
                : asleepReason === 'memory-pressure'
                  ? 'Asleep — evicted under memory pressure. Wakes on access, or wake now.'
                  : 'Asleep — containers removed to free memory. Wakes on access, or wake now.'
              : 'Free this stage’s memory now. On-demand stages wake automatically on access.'}
          </span>
          {asleep ? (
            <Button variant="outline" size="sm" className="ml-auto h-7" disabled={busy}
              onClick={() => power('wake')}>
              <Power className="mr-1.5 size-3.5" aria-hidden /> Wake
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="ml-auto h-7" disabled={busy || !anyRunning}
              onClick={() => power('sleep')}>
              <Moon className="mr-1.5 size-3.5" aria-hidden /> Put to sleep
            </Button>
          )}
        </div>
      )}
      {/* CouchDB keeps its console link here — it has no explorer replacement. */}
      <StageServicesRow stage={stage} only={['couchdb']} />
      {members.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-muted-foreground">
          No containers in {stageLabel}.
        </div>
      ) : (
        members.map((m) => <ContainerCard key={m.id} m={m} onAction={onAction} />)
      )}
        </>
      )}
    </div>
  );
}

/** Underlined sub-tab of the Containers section (Automation | Object Storage | SQL). */
function ContainersSubTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-10 items-center border-b-2 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
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
  if (e.source === 'secret')
    return { dot: 'bg-teal-500', label: 'Secret change', cls: 'bg-teal-100 text-teal-700' };
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
  // Secrets snapshot — the decrypted secrets as they were at THIS revision.
  // Keyed on the bitswan.yaml commit (entry.commit), not source_commit: a
  // secret-change event has no source commit, and the secrets live in
  // bitswan.yaml regardless. eslint-disable-next-line no-restricted-syntax
  const [secretsSnap, setSecretsSnap] = useState<
    import('@/lib/api').BpSecretsSnapshot | null
    // eslint-disable-next-line no-restricted-syntax -- null = not loaded
  >(null);
  const [secretsLoading, setSecretsLoading] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [revealSecrets, setRevealSecrets] = useState(false);

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

  // Load the secrets snapshot when the Secrets tab opens.
  useEffect(() => {
    if (panel !== 'secrets' || !entry.commit) return;
    let alive = true;
    setSecretsLoading(true);
    setSecretsError(null);
    setSecretsSnap(null);
    api
      .bpSecretsSnapshot(bp, entry.commit, stage)
      .then((r) => alive && setSecretsSnap(r))
      .catch((e) => alive && setSecretsError(String(e)))
      .finally(() => alive && setSecretsLoading(false));
    return () => {
      alive = false;
    };
  }, [panel, bp, entry.commit, stage]);

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
                  Bundles the deployment&apos;s source at{' '}
                  <span className="font-mono">{short(commit, 8)}</span> into one
                  archive you can use to recreate this business process later.
                </p>
                <div className="flex flex-col gap-1.5 text-[13px] text-foreground">
                  {['Source code at the deployed commit', 'Manifest recording the stage and commit'].map((l) => (
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
                    Restore it via &ldquo;+ New Business Process → Restore from
                    bundle&rdquo; — container images are rebuilt and databases
                    provisioned fresh by the normal deploy pipeline.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs">
                  <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    Secret values at{' '}
                    <span className="font-mono">{short(entry.commit, 8)}</span>
                    {secretsSnap && (
                      <span className="text-muted-foreground"> · {secretsSnap.realm}</span>
                    )}
                  </span>
                  {secretsSnap && Object.keys(secretsSnap.values).length > 0 && (
                    <button
                      type="button"
                      onClick={() => setRevealSecrets((v) => !v)}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {revealSecrets ? (
                        <>
                          <EyeOff className="size-3" aria-hidden /> Hide
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" aria-hidden /> Reveal
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {secretsLoading ? (
                    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
                    </div>
                  ) : secretsError ? (
                    <div className="flex h-full items-center justify-center text-sm text-destructive">
                      Failed to load secrets: {secretsError}
                    </div>
                  ) : secretsSnap && Object.keys(secretsSnap.values).length > 0 ? (
                    <table className="w-full border-collapse text-[13px]">
                      <tbody>
                        {Object.entries(secretsSnap.values).map(([k, v]) => (
                          <tr key={k} className="border-b border-border/60 align-top">
                            <td className="py-1.5 pr-4 font-mono font-medium text-foreground">
                              {k}
                            </td>
                            <td className="py-1.5 font-mono text-muted-foreground break-all">
                              {revealSecrets ? v : '••••••••'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <Lock className="size-6" aria-hidden />
                      {secretsSnap?.realm === 'production' ? (
                        <div className="max-w-xs">
                          Production secrets are visible to admins and auditors only.
                        </div>
                      ) : (
                        <div className="max-w-xs">No secrets set at this revision.</div>
                      )}
                    </div>
                  )}
                </div>
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
  const audits = entry.audit ?? [];
  // Which auditors' notes are expanded (badge is clickable to reveal the note).
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
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
          {isCurrent ? (
            // The newest entry is the current state — you are already here, so
            // there is nothing to roll back TO. Manage the running deployment.
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
          ) : isBackup ? (
            // Backup-domain audit record — read-only here (swaps/restores are
            // driven from the Backups + Disaster Recovery panels).
            null
          ) : isFw ? (
            // Firewall audit-log entry: restore the rule set to this commit.
            <Button variant="outline" size="sm" disabled={busy} onClick={onRollback}>
              <Undo2 className="size-3.5" aria-hidden />
              Restore rules
            </Button>
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
      {/* Audited-by badges (production promotes): the auditor(s) who signed off
          this image; each chip is clickable to reveal their note. */}
      {audits.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
              Audited by
            </span>
            {audits.map((a) => (
              <button
                key={a.who}
                type="button"
                onClick={() => setOpenNotes((o) => ({ ...o, [a.who]: !o[a.who] }))}
                title="Show this auditor's note"
                aria-expanded={!!openNotes[a.who]}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
              >
                <User className="size-3" aria-hidden />
                {a.who}
              </button>
            ))}
          </div>
          {audits
            .filter((a) => openNotes[a.who])
            .map((a) => (
              <div
                key={a.who}
                className="rounded-md border-l-2 border-emerald-300 bg-emerald-50/50 px-2.5 py-1.5 text-[12px]"
              >
                <div className="text-[11px] font-medium text-foreground">
                  {a.who}
                  {a.at ? <span className="font-normal text-muted-foreground"> · {a.at}</span> : null}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                  {a.note || 'Approved (no note left).'}
                </div>
              </div>
            ))}
        </div>
      )}
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
  // Freeze + audit gate: who I am (role gates Freeze / audit sign-off / policy),
  // and this BP's staging-gate state (frozen flag, audit policy, audit log).
  // eslint-disable-next-line no-restricted-syntax -- null = role not resolved yet
  const [role, setRole] = useState<'admin' | 'auditor' | 'member' | null>(null);
  const [meEmail, setMeEmail] = useState('');
  // eslint-disable-next-line no-restricted-syntax -- null = gate not loaded yet
  const [gate, setGate] = useState<StagingGate | null>(null);
  const [freezeBusy, setFreezeBusy] = useState(false);

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

  // My identity/role — gates the Freeze control, policy editing and audit
  // sign-off (fails closed to 'member' on error).
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((m) => {
        if (!alive) return;
        setRole(m.role ?? 'member');
        setMeEmail(m.email ?? '');
      })
      .catch(() => {
        if (alive) setRole('member');
      });
    return () => {
      alive = false;
    };
  }, []);

  // This BP's staging freeze + audit gate.
  useEffect(() => {
    let alive = true;
    api
      .stagingGate(bp.name)
      .then((g) => {
        if (alive) setGate(g);
      })
      .catch(() => {
        if (alive) setGate(null);
      });
    return () => {
      alive = false;
    };
  }, [bp.name, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const isDr = activeStage === 'dr';

  // The "Restore" action (stage row, between Production and DR) goes live on the
  // recovered environment: swap which slot is Production vs DR — an ingress
  // cutover + pointer flip, no data move. Confirmed because it changes which
  // environment real users hit.
  const [swapConfirm, setSwapConfirm] = useState(false);
  const [swapping, setSwapping] = useState(false);
  // Persistent surfacing of a failed deploy/promote for THIS stage. A toast is
  // transient; the deployments view must SHOW the failure on screen rather than
  // silently falling back to "Not deployed yet" (which forces you to go dig in
  // container logs). Cleared when the stage view changes or a new attempt starts.
  const [deployError, setDeployError] = useState<{ stage: string; msg: string } | null>(null);
  // Live deploy/promote progress shown ON the stage card (not only in the
  // transient toast). A promote runs tens of seconds — image promote, ingress
  // reconcile, blue-green slots — during which the stage card would otherwise
  // read a static "never deployed" until the final refresh. Surfacing the live
  // step keeps the operator (and the e2e progress watchdog) informed.
  const [deployProgress, setDeployProgress] = useState<{ stage: string; msg: string } | null>(
    null,
  );
  useEffect(() => {
    setDeployError(null);
  }, [activeStage]);
  const runSwap = useCallback(async () => {
    setSwapping(true);
    const work = api.swapProductionDr(bp.name);
    toast.promise(work, {
      loading: 'Switching Production ↔ Disaster Recovery…',
      success: (s) =>
        `Switched — Production now serves slot ${s.live_slot.toUpperCase()} (database ${s.live_db})`,
      error: (e: unknown) => `Switch failed: ${String(e)}`,
    });
    try {
      await work;
      refresh();
    } catch {
      /* toast handled */
    } finally {
      setSwapping(false);
      setSwapConfirm(false);
    }
  }, [bp.name, refresh]);
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

  // The DR stage serves the STANDBY blue-green slot. Its containers share the
  // live slot's state (both slots always run), but "Open app" must point at the
  // standby slot's own URL so operators verify the recovered app before swapping
  // it live — not at the production URL (which the ingress routes to the LIVE
  // slot). Fetch which slot is DR and rewrite the frontend URL to its host.
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded / not DR
  const [drSlot, setDrSlot] = useState<string | null>(null);
  useEffect(() => {
    if (!isDr) {
      setDrSlot(null);
      return;
    }
    let alive = true;
    api
      .backups(bp.name)
      .then((b) => alive && setDrSlot(b.dr_slot))
      .catch(() => alive && setDrSlot(null));
    return () => {
      alive = false;
    };
  }, [isDr, bp.name, reloadKey]);

  // Live containers for the current deployment. On DR, resolve each member to
  // the STANDBY slot's own container (`<id>@<dr_slot>`, surfaced separately by
  // the introspection overlay) — distinct from the live slot's container, and
  // carrying the stable `-dr` URL. The live slot keeps the bare id.
  const members = useMemo(() => {
    if (!currentEntry) return [];
    return Object.keys(currentEntry.members).map((id) => {
      const lookupId = isDr && drSlot ? `${id}@${drSlot}` : id;
      const a = automations.find((x) => x.deployment_id === lookupId);
      return {
        // Use the slot-specific id so Logs / Inspect / start-stop target the
        // DR slot's actual container (…@<dr_slot>), not the live one.
        id: lookupId,
        name: a?.automation_name ?? id,
        present: !!a?.deployment_id,
        display: a?.deployment_id ? stateToDisplay(a.state) : 'not-deployed',
        replicas: a?.replicas ?? 0,
        url: a?.automation_url ?? null,
        expose: a?.expose ?? false,
        memUsageBytes: a?.mem_usage_bytes ?? null,
        memReservationMB: a?.mem_reservation_mb ?? null,
        memOver: a?.mem_over_reservation ?? false,
        asleepReason: a?.asleep_reason ?? null,
      };
    });
  }, [currentEntry, automations, isDr, drSlot]);
  const frontends = members.filter((m) => m.expose);
  const replicaTotal = members.reduce((a, m) => a + (m.replicas || 0), 0);

  const runRollback = useCallback(
    async (entry: BpHistoryEntry) => {
      const isFw = entry.source === 'firewall';
      const ver = short(entry.source_commit ?? entry.commit, 8);
      // Rollback restores the whole bitswan.yaml at this commit (deploy, secret,
      // etc. all restore the same way); only the role-gated firewall path differs.
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
      setDeployError(null);
      // Show "Promoting…" on the target stage card immediately, then track the
      // live step messages — so the card never sits on a static "never
      // deployed" through the (multi-second) promote.
      setDeployProgress({ stage: target, msg: `Promoting to ${target}…` });
      await promoteBpWithToast({
        bp: bp.name,
        stage: target,
        loading: `Promoting ${bp.name} to ${target}…`,
        success: `${bp.name} promoted to ${target}`,
        failurePrefix: `Failed to promote ${bp.name} to ${target}`,
        // Keep the failure on screen for the target stage, not just a toast.
        onError: (msg) => setDeployError({ stage: target, msg }),
        // Mirror each live step onto the stage card.
        onProgress: (msg) => setDeployProgress({ stage: target, msg }),
      });
      setDeployProgress(null);
      setBusy(false);
      refresh();
    },
    [bp.name, refresh],
  );

  const runFreeze = useCallback(
    async (frozen: boolean) => {
      setFreezeBusy(true);
      const work = api.setStagingFreeze(bp.name, frozen);
      toast.promise(work, {
        loading: frozen ? 'Freezing staging for audit…' : 'Unfreezing staging…',
        success: frozen
          ? 'Staging frozen — promotion from Development is closed until you unfreeze'
          : 'Staging unfrozen — promotion from Development re-opened',
        error: (e: unknown) => `${frozen ? 'Freeze' : 'Unfreeze'} failed: ${String(e)}`,
      });
      try {
        await work;
        refresh();
      } catch {
        /* toast handled */
      } finally {
        setFreezeBusy(false);
      }
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
    const isUp = (m: Member) =>
      m.display === 'running' ||
      m.display === 'restarting' ||
      m.display === 'building' ||
      m.display === 'deployed';
    const failing = members.filter((m) => m.display === 'failed' || m.display === 'stopped').length;
    if (!currentEntry)
      return { label: 'Not deployed yet', color: 'text-muted-foreground', dot: 'bg-zinc-400', ring: 'ring-zinc-400/10' };
    // Deployed but nothing running = intentionally asleep (manual sleep or the
    // on-demand memory sweep). Distinct from a failure; wakes on access.
    if (members.length > 0 && !members.some(isUp))
      return { label: 'Asleep', color: 'text-sky-600', dot: 'bg-sky-500', ring: 'ring-sky-500/10' };
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
    const stage = isDr ? 'production' : activeStage;
    // Egress is observed asynchronously by the gateway, so the badge — like the
    // FirewallPanel itself — must poll; a one-shot fetch would stay at 0 even
    // after the BP's first outbound call gets logged, hiding the tab that needs
    // attention. Errors are swallowed; the next tick retries.
    const fetchBadge = () =>
      api
        .firewall(bp.name, stage)
        .then((r) => {
          if (!alive) return;
          const n = (r.attempts ?? []).length;
          setFirewallBadge(n ? [{ n, cls: 'bg-red-600', title: `${n} unreviewed blocked attempts` }] : []);
        })
        .catch(() => alive && setFirewallBadge([]));
    fetchBadge();
    const id = window.setInterval(fetchBadge, 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [bp.name, activeStage, isDr, reloadKey]);

  // Audits tab badge: while staging is frozen, surface outstanding sign-offs
  // (red on a requested-change, amber on remaining approvals) so the tab that
  // gates production is visible.
  const auditBadge = useMemo<{ n: number; cls: string; title: string }[]>(() => {
    if (!gate || !gate.frozen) return [];
    if (gate.rejections > 0)
      return [{ n: gate.rejections, cls: 'bg-red-600', title: 'Changes requested on the frozen image' }];
    const remaining = Math.max(0, gate.required - gate.approvals);
    return remaining
      ? [{ n: remaining, cls: 'bg-amber-500', title: `${remaining} more audit sign-off(s) required` }]
      : [];
  }, [gate]);

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
        { id: 'recovery', icon: LifeBuoy, label: 'Rehearse & restore' },
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
        // Audits live on Staging only — the gate is about freezing the staging
        // image and signing it off before it can be promoted to Production.
        ...(activeStage === 'staging'
          ? [{ id: 'audits' as Section, icon: Gavel, label: 'Audits', badges: auditBadge }]
          : []),
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

        {/* Stage pipeline — a bare stepper above the card (wireframe). Extra
            bottom padding leaves room for the Freeze pill that hangs below the
            Staging node. */}
        <div className="flex items-center gap-2 px-11 pb-12 pt-7">
          {STAGES.map((s, i) => {
            const sHist = byStage[stageDataId(s.id)];
            // "Deployed" needs a real deployment (an entry with a source
            // commit). Secret/firewall/backup audit records land in history
            // for stages that never deployed — declaring a secret writes
            // blobs to every realm — and must not light the stage up as ✓.
            const deployed =
              !!sHist && sHist.history.some((h) => !!h.source_commit);
            const next = STAGES[i + 1];
            // Promotable when the source stage RUNS different content than the
            // target — compared by baked-image content hash, not source_commit
            // (the dev image can be ahead of its committed HEAD, so the commit
            // would falsely read "same version").
            const srcKey = deployedContentKey(sHist);
            const tgtKey = next ? deployedContentKey(byStage[next.id]) : null;
            const canPromote = deployed && !!next && srcKey !== tgtKey;
            const auditor = isAuditor(role);

            // Each node sits in a `relative` cell so the active-stage vertical
            // connector (and, for staging, the Freeze control that hangs off the
            // node via an arc) can be absolutely positioned. The connector drops
            // to the card below; for the Staging stage it is a SHORT segment in
            // the lower section BELOW the Freeze pill, so it neither collides
            // with the pill nor gets clipped by the extra room the pill needs.
            const isActive = s.id === activeStage;
            const node = (
              <div className="relative flex shrink-0 flex-col items-center">
                <StageNode
                  stage={s}
                  deployed={deployed}
                  active={isActive}
                  onClick={() => setActiveStage(s.id)}
                />
                {s.id === 'staging' && (
                  <FreezeControl
                    gate={gate}
                    canManage={auditor}
                    busy={freezeBusy}
                    onToggle={(f) => {
                      // Freezing locks the image for review — jump straight to
                      // the staging Audits tab so the auditor can sign off.
                      if (f) {
                        setActiveStage('staging');
                        setSection('audits');
                      }
                      void runFreeze(f);
                    }}
                  />
                )}
                {isActive && (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute left-1/2 w-0.5 -translate-x-1/2 bg-primary',
                      s.id === 'staging' ? 'top-[102px] h-[18px]' : 'top-full h-[68px]',
                    )}
                  />
                )}
              </div>
            );

            // The inter-stage control encodes the freeze + audit gate:
            //   dev→staging   — a normal promote, but CLOSED while frozen.
            //   staging→prod   — needs freeze (locked otherwise), then the audit
            //                    policy met + an admin/auditor to click promote.
            let control: ReactNode = null;
            if (next?.id === 'dr') {
              // "Restore" = go live on the recovered environment (ingress cutover
              // + state flip, no data move). View/verify DR via its stage button.
              control = (
                <button
                  type="button"
                  onClick={() => setSwapConfirm(true)}
                  title="Restore: make Disaster Recovery the live Production (ingress cutover, no data moved)"
                  className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-3 text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Restore
                </button>
              );
            } else if (next && s.id === 'dev') {
              control = gate?.frozen ? (
                <LockedStep
                  label="Frozen"
                  title="Staging is frozen for audit — unfreeze it to promote from Development"
                />
              ) : (
                <PromoteButton
                  canPromote={canPromote}
                  label={next.label}
                  busy={busy}
                  onClick={() => void runPromote('staging')}
                />
              );
            } else if (next && s.id === 'staging') {
              // The Audits step is emitted separately (below) as its own pipeline
              // node BEFORE this promote control — wireframe ordering.
              if (!gate?.frozen) {
                control = (
                  <LockedStep
                    label="Freeze to unlock"
                    title="Freeze staging to enable promotion to Production"
                  />
                );
              } else {
                const promotable = canPromote && gate.promotable && auditor;
                const reason = !auditor
                  ? 'Only admins and auditors can promote to Production — ask an auditor to review the frozen image'
                  : gate.stale
                    ? 'The staging image changed since it was frozen — re-freeze staging before promoting'
                    : gate.rejections > 0
                      ? 'An auditor requested changes on the frozen image — address them and re-freeze'
                      : !gate.audits_met
                        ? `Audits incomplete — ${gate.approvals} of ${gate.required} sign-offs on the frozen staging image`
                        : !canPromote
                          ? 'Production already matches the frozen Staging image'
                          : `Promote the frozen staging image to ${next.label}`;
                control = (
                  <PromoteButton
                    canPromote={promotable}
                    label={next.label}
                    busy={busy}
                    blockedTitle={reason}
                    onClick={() => void runPromote('production')}
                  />
                );
              }
            } else if (next) {
              control = (
                <PromoteButton
                  canPromote={canPromote}
                  label={next.label}
                  busy={busy}
                  onClick={() => void runPromote(next.id as 'staging' | 'production')}
                />
              );
            }

            return (
              <Fragment key={s.id}>
                {node}
                {next && (
                  <>
                    <div className="h-0.5 flex-1 bg-border" aria-hidden />
                    {/* staging → production runs through an Audits step first */}
                    {s.id === 'staging' && gate && (
                      <>
                        <AuditsBadge
                          gate={gate}
                          onClick={() => {
                            setActiveStage('staging');
                            setSection('audits');
                          }}
                        />
                        <div className="h-0.5 flex-1 bg-border" aria-hidden />
                      </>
                    )}
                    <div className="shrink-0">{control}</div>
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
                {deployProgress && deployProgress.stage === activeStage ? (
                  <div className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    {deployProgress.msg}
                  </div>
                ) : (
                  <div className={cn('mt-0.5 text-[13px] font-semibold', friendly.color)}>
                    {friendly.label}
                    <span className="font-normal text-muted-foreground">
                      {currentEntry?.deployed_at ? ` · updated ${currentEntry.deployed_at}` : ' · never deployed'}
                    </span>
                  </div>
                )}
                {deployError && deployError.stage === activeStage && (
                  <div className="mt-1.5 rounded-md bg-red-50 px-2.5 py-1.5 text-[12px] font-medium text-red-700 ring-1 ring-red-200">
                    Last deploy to {STAGE_LABEL[activeStage]} failed: {deployError.msg}
                  </div>
                )}
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
                  const running = f.display === 'running';
                  // A URL is openable even when the container is down: opening an
                  // on-demand host wakes it (loading screen → app). Only when there
                  // is no URL at all is it truly unreachable.
                  const openable = !!f.url;
                  const subtitle = f.url
                    ? running
                      ? f.url.replace('https://', '')
                      : 'Asleep — opens with a loading screen'
                    : 'Not deployed';
                  const inner = (
                    <>
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg',
                          running ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <Globe className="size-[18px]" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate font-mono text-[13px] font-semibold',
                            openable ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {f.name}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {subtitle}
                        </span>
                      </span>
                      {openable ? (
                        running ? (
                          <ExternalLink className="size-3.5 shrink-0 text-primary" aria-hidden />
                        ) : (
                          <Moon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        )
                      ) : (
                        <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                    </>
                  );
                  return openable ? (
                    <a
                      key={f.id}
                      href={f.url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(
                        'flex w-[280px] max-w-full items-center gap-2.5 rounded-[10px] border border-border px-3.5 py-3 hover:border-primary/40 hover:shadow-sm',
                        !running && 'bg-muted/30',
                      )}
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
              <DrArchitectureDoc bp={bp.name} />
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
                bp={bp.name}
                onAction={runContainer}
                onRefresh={refresh}
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
            ) : visibleSection === 'audits' ? (
              <AuditsPanel
                bp={bp.name}
                gate={gate}
                role={role}
                meEmail={meEmail}
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

      {/* Restore = go live on the recovered (DR) environment via a slot swap. */}
      <AlertDialog open={swapConfirm} onOpenChange={(o) => !o && setSwapConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make Disaster Recovery the live Production?</AlertDialogTitle>
            <AlertDialogDescription>
              Production traffic for <span className="font-mono">{bp.name}</span> will switch to the
              standby (Disaster Recovery) slot, and the current Production becomes the new standby.
              This is an <strong>ingress cutover plus a state flip</strong> — no data is moved and
              nothing is rebuilt. Verify the DR environment first; you can switch straight back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSwapConfirm(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={swapping} onClick={() => void runSwap()}>
              {swapping ? 'Switching…' : 'Restore — go live'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
