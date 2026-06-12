import { Code2, FlaskConical, Rocket, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SNAPSHOT_STAGES, type SnapshotStage } from '@/types';

export const STAGE_META: Record<
  SnapshotStage,
  { label: string; Icon: LucideIcon; badge: string }
> = {
  dev: {
    label: 'Development',
    Icon: Code2,
    badge: 'border-sky-200 bg-sky-50 text-sky-700',
  },
  staging: {
    label: 'Staging',
    Icon: FlaskConical,
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  production: {
    label: 'Production',
    Icon: Rocket,
    badge: 'border-red-200 bg-red-50 text-red-700',
  },
};

interface StagePickerProps {
  // eslint-disable-next-line no-restricted-syntax -- null = nothing picked yet
  value: SnapshotStage | null;
  onChange: (stage: SnapshotStage) => void;
  /** Stages that can be picked; others render disabled. */
  enabled?: SnapshotStage[];
  /** Stage to exclude entirely (e.g. clone source ≠ target). */
  exclude?: SnapshotStage;
}

/** Segmented three-way stage selector used by the snapshot dialogs. */
export function StagePicker({ value, onChange, enabled, exclude }: StagePickerProps) {
  return (
    <div className="flex gap-1.5">
      {SNAPSHOT_STAGES.filter((s) => s !== exclude).map((s) => {
        const meta = STAGE_META[s];
        const disabled = enabled ? !enabled.includes(s) : false;
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s)}
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
  );
}
