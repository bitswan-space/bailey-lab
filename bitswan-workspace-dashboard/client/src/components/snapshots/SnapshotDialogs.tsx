import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Camera, TriangleAlert } from 'lucide-react';
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

function TypedConfirmation({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] text-muted-foreground">
        Restoring into <strong className="text-red-600">production</strong>.
        Type <span className="font-mono font-semibold text-foreground">{slug}</span>{' '}
        to confirm:
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={slug}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function CreateSnapshotDialog({
  open,
  enabledStages,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  enabledStages: SnapshotStage[];
  onCancel: () => void;
  onConfirm: (stage: SnapshotStage, label: string) => void;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [stage, setStage] = useState<SnapshotStage | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (open) {
      setStage(enabledStages[0] ?? null);
      setLabel('');
    }
  }, [open, enabledStages]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create snapshot</DialogTitle>
          <DialogDescription>
            Capture this business process&apos;s data (Postgres, CouchDB, MinIO)
            at one stage. Manual snapshots are kept until you delete them.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <StagePicker value={stage} onChange={setStage} enabled={enabledStages} />
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

export function RestoreDialog({
  snapshot,
  bpSlug,
  enabledStages,
  onCancel,
  onConfirm,
}: {
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  snapshot: Snapshot | null;
  bpSlug: string;
  enabledStages: SnapshotStage[];
  onCancel: () => void;
  onConfirm: (snapshot: Snapshot, target: SnapshotStage) => void;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  const [target, setTarget] = useState<SnapshotStage | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (snapshot) {
      setTarget(snapshot.stage);
      setTyped('');
    }
  }, [snapshot]);

  const needsTyped = target === 'production';
  const confirmEnabled =
    !!snapshot && !!target && (!needsTyped || typed.trim() === bpSlug);

  return (
    <Dialog open={snapshot !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore snapshot</DialogTitle>
          <DialogDescription>
            {snapshot
              ? `Restore “${snapshot.label || snapshot.id}” (taken on ${STAGE_META[snapshot.stage].label}) into any stage.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="text-[13px] font-medium text-muted-foreground">
            Restore into
          </div>
          <StagePicker
            value={target}
            onChange={(s) => {
              setTarget(s);
              setTyped('');
            }}
            enabled={enabledStages}
          />
          {target && <ReplaceWarning target={target} />}
          {needsTyped && (
            <TypedConfirmation slug={bpSlug} value={typed} onChange={setTyped} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={needsTyped ? 'destructive' : 'default'}
            disabled={!confirmEnabled}
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
  bpSlug,
  enabledStages,
  fixedSource,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  bpSlug: string;
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
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) {
      setSource(fixedSource ?? enabledStages[0] ?? null);
      setTarget(null);
      setTyped('');
    }
  }, [open, enabledStages, fixedSource]);

  const targetChoices = useMemo(
    () => enabledStages.filter((s) => s !== source),
    [enabledStages, source],
  );
  const needsTyped = target === 'production';
  const confirmEnabled =
    !!source &&
    !!target &&
    source !== target &&
    (!needsTyped || typed.trim() === bpSlug);

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
                  setTyped('');
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
            onChange={(s) => {
              setTarget(s);
              setTyped('');
            }}
            enabled={targetChoices}
            exclude={source ?? undefined}
          />
          {target && <ReplaceWarning target={target} />}
          {needsTyped && (
            <TypedConfirmation slug={bpSlug} value={typed} onChange={setTyped} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={needsTyped ? 'destructive' : 'default'}
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
