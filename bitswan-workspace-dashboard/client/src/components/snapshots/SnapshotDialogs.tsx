import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Camera, LifeBuoy, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { StagePicker, STAGE_META } from '@/components/snapshots/StagePicker';
import type { Snapshot, SnapshotStage } from '@/types';

/**
 * The three snapshot-tab dialogs: Create, Restore, Clone. Restore/Clone
 * carry the replace-semantics warning, and a production target requires
 * typing the BP slug before the confirm button enables (no role system
 * exists — typed confirmation is the guard rail).
 */

function ReplaceWarning({ target }: { target: SnapshotStage }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-snug text-amber-800">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        The current <strong>{STAGE_META[target].label}</strong> data will be
        auto-snapshotted first, then <strong>replaced</strong>. Code and
        deployments are not touched.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function CreateSnapshotDialog({
  open,
  enabledStages,
  fixedStage,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  enabledStages: SnapshotStage[];
  /** When set (per-stage Backups tab), the snapshot is of THIS stage — no
   *  stage picker is shown; you're already scoped to it. */
  fixedStage?: SnapshotStage;
  onCancel: () => void;
  onConfirm: (stage: SnapshotStage, label: string) => void;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [stage, setStage] = useState<SnapshotStage | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (open) {
      setStage(fixedStage ?? enabledStages[0] ?? null);
      setLabel('');
    }
  }, [open, enabledStages, fixedStage]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create snapshot</DialogTitle>
          <DialogDescription>
            {fixedStage
              ? `Capture ${STAGE_META[fixedStage].label}'s data (Postgres, CouchDB, MinIO). Manual snapshots are kept until you delete them.`
              : "Capture this business process's data (Postgres, CouchDB, MinIO) at one stage. Manual snapshots are kept until you delete them."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!fixedStage && (
            <StagePicker value={stage} onChange={setStage} enabled={enabledStages} />
          )}
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional) — e.g. before-release"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!stage}
            onClick={() => stage && onConfirm(stage, label.trim())}
          >
            <Camera className="size-3.5" aria-hidden />
            Create snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Where a restore may land. NEVER live Production — recovery goes into the
 *  isolated Disaster-Recovery slot (then a swap goes live). dev/staging are
 *  in-place. */
export type RestoreTarget = 'dev' | 'staging' | 'dr';

const RESTORE_TARGET_META: Record<
  RestoreTarget,
  { label: string; Icon: LucideIcon; badge: string }
> = {
  dev: STAGE_META.dev,
  staging: STAGE_META.staging,
  dr: {
    label: 'Disaster Recovery',
    Icon: LifeBuoy,
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
};

export function RestoreDialog({
  snapshot,
  enabledStages,
  onCancel,
  onConfirm,
}: {
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  snapshot: Snapshot | null;
  /** Snapshot-enabled stages (dev/staging) — controls which in-place targets
   *  are pickable. DR is always offered (it's the safe recovery sink). */
  enabledStages: SnapshotStage[];
  onCancel: () => void;
  onConfirm: (snapshot: Snapshot, target: RestoreTarget) => void;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [target, setTarget] = useState<RestoreTarget | null>(null);

  useEffect(() => {
    // Default to DR — the safe recovery path; live Production is never a target.
    if (snapshot) setTarget('dr');
  }, [snapshot]);

  const choices: RestoreTarget[] = ['dev', 'staging', 'dr'];
  const pickable = (t: RestoreTarget) => t === 'dr' || enabledStages.includes(t as SnapshotStage);

  return (
    <Dialog open={snapshot !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore snapshot</DialogTitle>
          <DialogDescription>
            {snapshot
              ? `Restore “${snapshot.label || snapshot.id}” (taken on ${STAGE_META[snapshot.stage].label}). Restoring directly onto live Production is not allowed — recover into Disaster Recovery, verify, then swap to go live.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="text-[13px] font-medium text-muted-foreground">Restore into</div>
          <div className="flex gap-1.5">
            {choices.map((t) => {
              const meta = RESTORE_TARGET_META[t];
              const disabled = !pickable(t);
              const active = target === t;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTarget(t)}
                  title={disabled ? 'Snapshots not enabled for this stage' : meta.label}
                  className={cn(
                    'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-[13px] font-medium transition-colors',
                    active
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                  )}
                >
                  <meta.Icon className="size-3.5" aria-hidden />
                  {meta.label}
                </button>
              );
            })}
          </div>
          {target === 'dr' ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] leading-snug text-emerald-800">
              <LifeBuoy className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Restored into the isolated <strong>Disaster Recovery</strong> slot — live Production
                is untouched. Verify the data there, then swap DR with Production to go live.
              </span>
            </div>
          ) : (
            target && <ReplaceWarning target={target as SnapshotStage} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!snapshot || !target}
            onClick={() => snapshot && target && onConfirm(snapshot, target)}
          >
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export function CloneDialog({
  open,
  enabledStages,
  fixedSource,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  enabledStages: SnapshotStage[];
  /** When set, the source stage is implied (per-stage view) — no "From"
   *  picker is shown and only the target is chosen. */
  fixedSource?: SnapshotStage;
  onCancel: () => void;
  onConfirm: (source: SnapshotStage, target: SnapshotStage) => void;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [source, setSource] = useState<SnapshotStage | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [target, setTarget] = useState<SnapshotStage | null>(null);

  useEffect(() => {
    if (open) {
      setSource(fixedSource ?? enabledStages[0] ?? null);
      setTarget(null);
    }
  }, [open, enabledStages, fixedSource]);

  // Never clone onto live Production (same rule as restore — go via DR + swap).
  const targetChoices = useMemo(
    () => enabledStages.filter((s) => s !== source && s !== 'production'),
    [enabledStages, source],
  );
  const confirmEnabled = !!source && !!target && source !== target;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone stage data</DialogTitle>
          <DialogDescription>
            {fixedSource
              ? `One-click copy of ${STAGE_META[fixedSource].label}’s data into another stage — e.g. seed Staging from Production.`
              : 'One-click copy of this business process’s data from one stage into another — e.g. seed Staging from Production.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {fixedSource ? (
            <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
              Copy{' '}
              <strong className="text-foreground">
                {STAGE_META[fixedSource].label}
              </strong>
              <ArrowRight className="size-3.5" aria-hidden />
              into
            </div>
          ) : (
            <>
              <div className="text-[13px] font-medium text-muted-foreground">From</div>
              <StagePicker
                value={source}
                onChange={(s) => {
                  setSource(s);
                  if (target === s) setTarget(null);
                }}
                enabled={enabledStages}
              />
              <div className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                <ArrowRight className="size-3.5" aria-hidden />
                Into
              </div>
            </>
          )}
          <StagePicker
            value={target}
            onChange={(s) => setTarget(s)}
            enabled={targetChoices}
            exclude={source ?? undefined}
          />
          {target && <ReplaceWarning target={target} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!confirmEnabled}
            onClick={() => source && target && onConfirm(source, target)}
          >
            Clone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
