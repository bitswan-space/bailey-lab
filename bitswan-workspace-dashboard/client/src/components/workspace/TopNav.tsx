import { useMemo, useState } from 'react';
import {
  Bot,
  CheckSquare,
  ChevronRight,
  FileText,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { BpSelector } from '@/components/workspace/BpSelector';
import { CopySelector } from '@/components/workspace/CopySelector';
import { NewBusinessProcessDialog } from '@/components/workspace/NewBusinessProcessDialog';
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
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  copies: Copy[];
  onSelectCopy: (name: string) => void;
  onPullCopy: (name: string) => Promise<void>;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
  role: Role;
}

interface FlowStep {
  id: FlowTab;
  label: string;
  Icon: LucideIcon;
  /** Requires a selected copy to be usable. */
  needsCopy: boolean;
}

// The steps that happen INSIDE the copy — everything up to and including
// Sync & Deploy. These live inside the "copy region" card in the top bar.
const IN_COPY_STEPS: FlowStep[] = [
  { id: 'description', label: 'Description', Icon: FileText, needsCopy: false },
  { id: 'agent', label: 'Coding Agent', Icon: Bot, needsCopy: true },
  {
    id: 'requirements',
    label: 'Requirements & tests',
    Icon: CheckSquare,
    needsCopy: true,
  },
  { id: 'sync-deploy', label: 'Sync & Deploy', Icon: Rocket, needsCopy: true },
];

// Deployments live in the shared MAIN area, not the copy — so it sits OUTSIDE
// the copy card. Sync & Deploy is the boundary: it publishes the copy to main.
const DEPLOYMENTS_STEP: FlowStep = {
  id: 'deployments',
  label: 'Deployments',
  Icon: Server,
  needsCopy: false,
};

/**
 * The single top bar of the shell, in two sections that mirror where work
 * actually happens:
 *
 *   [ Process ] [ Automate ]   ┌ copy region ─────────────────────────────┐   → [ Deployments ]
 *                              │ [ Copy ] Description › Agent ↻ Reqs › Sync&Deploy │
 *                              └───────────────────────────────────────────┘
 *
 * The business process is the subject; the copy and every step up to Sync &
 * Deploy are wrapped in a card so it's visually clear they all happen inside
 * the chosen copy. Deployments sits outside — the deploy crosses into the
 * shared main area.
 */
export function TopNav({
  bps,
  activeBpId,
  onSelectBp,
  copy,
  copies,
  onSelectCopy,
  onPullCopy,
  tab,
  onTab,
  role,
}: TopNavProps) {
  const roleMeta = ROLE_META[role] ?? ROLE_META.member;
  const [automateOpen, setAutomateOpen] = useState(false);

  const activeBp = useMemo(
    () => bps.find((b) => b.id === activeBpId) ?? null,
    [bps, activeBpId],
  );
  // BPs already in the selected copy — so the create dialog can reject dupes.
  const copyBpNames = useMemo(
    () =>
      copy ? bps.filter((b) => b.copies.includes(copy)).map((b) => b.name) : [],
    [bps, copy],
  );

  // Picking a business process keeps the (BP, copy) selection consistent: if
  // the current copy doesn't carry the new BP, jump to the first copy that does.
  const handleSelectBp = (id: string) => {
    onSelectBp(id);
    const bp = bps.find((b) => b.id === id);
    if (bp && (!copy || !bp.copies.includes(copy))) {
      const first = copies.find((c) => bp.copies.includes(c.name));
      if (first) onSelectCopy(first.name);
    }
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
      <BpSelector
        bps={bps}
        activeBpId={activeBpId}
        onSelect={handleSelectBp}
        onNewBp={() => setAutomateOpen(true)}
      />

      {/* The copy region: the copy selector, the "add a process to this copy"
          action, and every step up to Sync & Deploy live in one card, so it's
          visually clear they all happen inside the chosen copy. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-muted/40 px-1.5 py-1">
        <CopySelector
          copies={copies}
          selectedBp={activeBp}
          copy={copy}
          onSelect={onSelectCopy}
          onPull={onPullCopy}
          onCreatedCopy={(name) => onSelectCopy(name)}
        />
        {/* Add a new business process IN this copy. Quiet, tab-styled — a
            secondary action that belongs to the copy. */}
        <button
          type="button"
          onClick={() => copy && setAutomateOpen(true)}
          disabled={copy === null}
          title={
            copy === null
              ? 'Create or select a copy first'
              : 'Create a new business process in this copy'
          }
          className={cn(
            'inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
            copy === null && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
        >
          <Plus className="size-3.5" aria-hidden />
          New Business Process
        </button>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {IN_COPY_STEPS.map((step, i) => (
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

      <NewBusinessProcessDialog
        open={automateOpen}
        onOpenChange={setAutomateOpen}
        copy={copy ?? undefined}
        existingNames={copyBpNames}
        onCreated={(name) => {
          // Select the new BP and land on its Description (the copy is already
          // the selected one).
          onSelectBp(name);
          onTab('description');
        }}
      />
    </div>
  );
}
