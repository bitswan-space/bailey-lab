import { useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Bot,
  CheckSquare,
  ChevronRight,
  Compass,
  FileText,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { AdvancedMenu } from '@/components/workspace/AdvancedMenu';
import { BpSelector } from '@/components/workspace/BpSelector';
import { DeleteBusinessProcessDialog } from '@/components/workspace/DeleteBusinessProcessDialog';
import { NewBusinessProcessDialog } from '@/components/workspace/NewBusinessProcessDialog';
import { RenameBusinessProcessDialog } from '@/components/workspace/RenameBusinessProcessDialog';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import type { BusinessProcess, FlowTab, Copy } from '@/types';

type Role = 'admin' | 'auditor' | 'member';
const ROLE_META: Record<Role, { label: string; cls: string; hint: string }> = {
  admin: {
    label: 'Admin',
    cls: 'border-violet-300 bg-violet-50 text-violet-700',
    hint: 'Admin — full access, including changing recovery-test cadence and other governance settings.',
  },
  auditor: {
    label: 'Auditor',
    cls: 'border-sky-300 bg-sky-50 text-sky-700',
    hint: 'Auditor — can review everything and change governance settings such as the recovery-test cadence.',
  },
  member: {
    label: 'Member',
    cls: 'border-border bg-muted/60 text-muted-foreground',
    hint: 'Member — day-to-day access. Governance settings (e.g. recovery-test cadence) are read-only for you.',
  },
};

interface TopNavProps {
  bps: BusinessProcess[];
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected yet
  activeBpId: string | null;
  onSelectBp: (id: string) => void;
  onBpCreated: (name: string) => void;
  /** A business process is being materialized into the copy in view (the id
   *  while it runs, null when it settles). The shell shows an "adding…" body
   *  instead of "this process isn't in this copy" while it's in flight —
   *  routine inside an experiment, which only clones the one process it was
   *  started on. */
  // eslint-disable-next-line no-restricted-syntax -- null = nothing in flight
  onAddingBpChange?: (bp: string | null) => void;
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  copies: Copy[];
  /** Move to another copy WITH the interface locked until the destination is
   *  fully renderable — the only way the chrome should ever change copy. */
  onEnterCopy: (name: string, label: string, after?: () => Promise<void>) => void;
  /** Start an experiment on a business process. Owned by the shell (it is a
   *  copy transition, not a dialog's private business). */
  onStartExperiment: (title: string, bp: BusinessProcess) => void;
  /** The signed-in user's own personal copy. */
  // eslint-disable-next-line no-restricted-syntax -- null = not yet resolved
  myCopy: string | null;
  /** Main has changes the user's own copy lacks — the Sync step leads the
   *  pipeline while that holds, and is absent otherwise. */
  syncVisible: boolean;
  /** The copy in view is one of the user's own experiments: experiments merge
   *  back into their parent copy, never into main, so Deploy is absent. */
  isMyExperiment: boolean;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
  role: Role;
  /** "New business process" dialog open state, hoisted to App so the
   *  empty-state body can open it too. */
  newBpOpen: boolean;
  onNewBpOpenChange: (open: boolean) => void;
}

interface FlowStep {
  id: FlowTab;
  label: string;
  Icon: LucideIcon;
  /** Requires a selected copy to be usable. */
  needsCopy: boolean;
}

// Pulling main's changes INTO the copy. Only ever the first step of the
// pipeline, only on the user's own copy, and only while there is something to
// pull — see `syncVisible`.
const SYNC_STEP: FlowStep = {
  id: 'sync',
  label: 'Sync',
  Icon: ArrowDownToLine,
  needsCopy: true,
};

// The steps that always happen INSIDE the copy. These live inside the "copy
// region" card in the top bar.
const IN_COPY_STEPS: FlowStep[] = [
  { id: 'description', label: 'Description', Icon: FileText, needsCopy: false },
  { id: 'agent', label: 'Coding Agent', Icon: Bot, needsCopy: true },
  {
    id: 'requirements',
    label: 'Requirements & tests',
    Icon: CheckSquare,
    needsCopy: true,
  },
];

// The last step inside the copy: it publishes the copy's work to main. Absent
// in an experiment, which merges back into its parent copy instead.
const DEPLOY_STEP: FlowStep = {
  id: 'deploy',
  label: 'Deploy',
  Icon: Rocket,
  needsCopy: true,
};

// Deployments live in the shared MAIN area, not the copy — so it sits OUTSIDE
// the copy card. Deploy is the boundary: it publishes the copy to main.
const DEPLOYMENTS_STEP: FlowStep = {
  id: 'deployments',
  label: 'Deployments',
  Icon: Server,
  needsCopy: false,
};

// An always-available orientation page. It's NOT a pipeline stage (it needs no
// business process or copy), so it sits at the far left, set apart from the
// flow by a divider rather than a chevron.
const GET_STARTED_STEP: FlowStep = {
  id: 'get-started',
  label: 'Get started',
  Icon: Compass,
  needsCopy: false,
};

/**
 * The single top bar of the shell, in two sections that mirror where work
 * actually happens:
 *
 *   [ Get started ] │ [ Process ]  ┌ copy region ───────────────────────────┐  → [ Deployments ]   [ Advanced ] [ Role ]
 *                                  │ (Sync ›) Description › Agent ↻ Reqs › Deploy │
 *                                  └─────────────────────────────────────────┘
 *
 * The business process is the subject; every step up to Deploy is wrapped in a
 * card so it's visually clear they all happen inside the copy you're in.
 *
 * The bar says NOTHING about which copy that is: the everyday answer is always
 * "mine", so naming it in the chrome is noise. The exceptions announce
 * themselves in a full-width banner under the bar instead (someone else's copy,
 * or one of your experiments) and are switched between under Advanced.
 *
 * Deployments sits outside the card — the deploy crosses into the shared main
 * area.
 */
export function TopNav({
  bps,
  activeBpId,
  onSelectBp,
  onBpCreated,
  onAddingBpChange,
  copy,
  copies,
  onEnterCopy,
  onStartExperiment,
  myCopy,
  syncVisible,
  isMyExperiment,
  tab,
  onTab,
  role,
  newBpOpen,
  onNewBpOpenChange,
}: TopNavProps) {
  const roleMeta = ROLE_META[role] ?? ROLE_META.member;
  // eslint-disable-next-line no-restricted-syntax -- null = rename dialog closed
  const [renameBp, setRenameBp] = useState<BusinessProcess | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = delete dialog closed
  const [deleteBp, setDeleteBp] = useState<BusinessProcess | null>(null);

  const activeBp = useMemo(
    () => bps.find((b) => b.id === activeBpId) ?? null,
    [bps, activeBpId],
  );
  // Every business-process name on screen — the create dialog rejects dupes
  // against this, not against the copy's contents. A BP name IS its repo
  // (one repo per process, a branch per copy), so the namespace is
  // workspace-wide: creating "orders" in a copy that doesn't happen to carry
  // "orders" would collide with the existing repo. This used to filter by
  // `b.copies.includes(copy)`, which was only ever right while every copy
  // carried every process — inside an experiment (cloned with just the one
  // process it was started on) that list is a single name, and the check would
  // wave through a duplicate. Names living only in someone else's experiment
  // are filtered out of `bps` and so aren't covered here — gitops is the
  // authority on the collision either way; this is the fast, local answer.
  const existingBpNames = useMemo(() => bps.map((b) => b.name), [bps]);

  // The steps in view. Sync leads the pipeline only while main has something
  // the user's own copy lacks; Deploy is absent inside an experiment.
  const inCopySteps = useMemo(() => {
    const steps: FlowStep[] = [];
    if (syncVisible) steps.push(SYNC_STEP);
    steps.push(...IN_COPY_STEPS);
    if (!isMyExperiment) steps.push(DEPLOY_STEP);
    return steps;
  }, [syncVisible, isMyExperiment]);

  const currentCopy = useMemo(
    () => (copy ? (copies.find((c) => c.name === copy) ?? null) : null),
    [copies, copy],
  );

  // Picking a business process NEVER moves the user to another COPY — the copy
  // in view is where they work. When it doesn't carry the process yet, clone it
  // in (the ensureBp flow the old copy switcher used for its "+ from main"
  // rows; processes are created in main, so this covers ones other people
  // created).
  //
  // The one exception is an EXPERIMENT, and it is not really an exception: an
  // experiment is a side branch of ONE business process, so another process is
  // not something it can hold. gitops refuses to materialize one (409) — the
  // client must not ask, and must not leave the user staring at a body that
  // says the process isn't here. Picking another process LEAVES the experiment
  // for the copy it branched from, out loud (see `handleSelectBp`).
  // eslint-disable-next-line no-restricted-syntax -- null = nothing in flight
  const addingRef = useRef<string | null>(null);
  const materializeInto = (target: string, bp: BusinessProcess) => {
    if (bp.copies.includes(target)) return;
    const id = bp.id;
    addingRef.current = id;
    onAddingBpChange?.(id);
    void api.copyFiles
      .ensureBp(target, bp.name)
      .catch((err: unknown) => {
        toast.error(
          `Failed to add ${bp.displayName} to “${target}”: ${errorMessage(err)}`,
        );
      })
      .finally(() => {
        // A newer selection is already materializing — it owns the signal now.
        if (addingRef.current !== id) return;
        addingRef.current = null;
        onAddingBpChange?.(null);
      });
  };

  const handleSelectBp = (id: string) => {
    const bp = bps.find((b) => b.id === id);
    if (!bp || !copy) {
      onSelectBp(id);
      return;
    }

    // Inside an experiment, on a different business process: the experiment
    // cannot follow you there, so the copy has to change. Do it explicitly and
    // say why — a silent copy switch is how the user ends up editing somewhere
    // they didn't think they were.
    if (currentCopy?.kind === 'experiment' && bp.name !== currentCopy.bp) {
      const target = currentCopy.parent ?? myCopy;
      const label = currentCopy.title ?? currentCopy.name;
      if (!target) {
        // Nowhere to land: leave the user where they are rather than dropping
        // them into an arbitrary copy, and say so.
        toast.error(
          `“${label}” is an experiment on one business process only, and we ` +
            `couldn't work out which copy it branched from — so ${bp.displayName} ` +
            `can't be opened from in here. Reload once gitops is reachable.`,
        );
        return;
      }
      onSelectBp(id);
      onEnterCopy(
        target,
        `Leaving the experiment “${label}” — showing ${bp.displayName}…`,
      );
      toast.info(
        `Left the experiment “${label}” — an experiment is on one business ` +
          `process only. Now showing ${bp.displayName} in ` +
          `${target === myCopy ? 'your copy' : `“${target}”`}.`,
      );
      materializeInto(target, bp);
      return;
    }

    onSelectBp(id);
    materializeInto(copy, bp);
  };

  const renderStep = (step: FlowStep) => {
    const active = tab === step.id;
    const disabled = step.needsCopy && copy === null;
    return (
      <button
        type="button"
        onClick={() => !disabled && onTab(step.id)}
        disabled={disabled}
        title={disabled ? 'Create or select a copy first' : step.label}
        className={cn(
          'inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors',
          active
            ? 'bg-background font-semibold text-foreground shadow-sm'
            : 'font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        )}
      >
        <step.Icon className="size-3.5" aria-hidden />
        {step.label}
      </button>
    );
  };

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-6 py-2.5">
      {/* Orientation — set apart from the pipeline by a divider, not a chevron. */}
      {renderStep(GET_STARTED_STEP)}
      <div className="h-6 w-px shrink-0 bg-border" aria-hidden />

      <BpSelector
        bps={bps}
        activeBpId={activeBpId}
        onSelect={handleSelectBp}
        onNewBp={() => onNewBpOpenChange(true)}
        onRenameBp={setRenameBp}
        onDeleteBp={setDeleteBp}
      />

      {/* The copy region: whose copy this is, and every step up to Deploy, in
          one card — so it's visually clear they all happen inside that copy. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-muted/40 px-1.5 py-1">
        {/* No leading chevron: the card's own border already separates the copy
            region from the business-process selector, and whichever step comes
            first (Sync when main is ahead, otherwise Description) must read as
            the start of the pipeline, not as something chained off the left. */}
        {inCopySteps.map((step, i) => (
          <div key={step.id} className="flex shrink-0 items-center gap-1">
            {i > 0 &&
              // The design marks the Agent ↔ Requirements pair with a cycle
              // icon (iterate between them); plain chevrons elsewhere.
              (step.id === 'requirements' ? (
                <RefreshCw className="size-3 text-muted-foreground" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
              ))}
            {renderStep(step)}
          </div>
        ))}
      </div>

      {/* Crossing out of the copy into the shared main area. */}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {renderStep(DEPLOYMENTS_STEP)}

      <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">
        <AdvancedMenu
          copies={copies}
          copy={copy}
          myCopy={myCopy}
          bps={bps}
          selectedBp={activeBp}
          onEnterCopy={onEnterCopy}
          onSelectBp={onSelectBp}
          onStartExperiment={onStartExperiment}
        />
        <span
          title={roleMeta.hint}
          className={cn(
            'inline-flex h-[28px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium',
            roleMeta.cls,
          )}
        >
          <ShieldCheck className="size-3.5" aria-hidden />
          {roleMeta.label}
        </span>
      </div>

      <RenameBusinessProcessDialog
        bp={renameBp}
        onClose={() => setRenameBp(null)}
      />

      <DeleteBusinessProcessDialog
        bp={deleteBp}
        onClose={() => setDeleteBp(null)}
      />

      <NewBusinessProcessDialog
        open={newBpOpen}
        onOpenChange={onNewBpOpenChange}
        copy={copy ?? undefined}
        existingNames={existingBpNames}
        onCreated={(name) => {
          // Select the new BP and land on its Description (the copy is already
          // the selected one). onBpCreated marks it as just-created so the
          // consistency effect keeps it selected until the SSE feed delivers it
          // — otherwise the selection snaps to whichever BP sorts first.
          onBpCreated(name);
        }}
      />
    </div>
  );
}

