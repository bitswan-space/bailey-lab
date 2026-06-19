import {
  Bot,
  CheckSquare,
  ChevronRight,
  FileText,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { BpSwitcher } from '@/components/workspace/BpSwitcher';
import { CopySwitcher } from '@/components/workspace/CopySwitcher';
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
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
  role: Role;
}

const FLOW_STEPS: {
  id: FlowTab;
  label: string;
  Icon: LucideIcon;
  /** Requires a selected copy to be usable. */
  needsCopy: boolean;
}[] = [
  { id: 'description', label: 'Description', Icon: FileText, needsCopy: false },
  { id: 'agent', label: 'Coding Agent', Icon: Bot, needsCopy: true },
  {
    id: 'requirements',
    label: 'Requirements & tests',
    Icon: CheckSquare,
    needsCopy: true,
  },
  { id: 'sync-deploy', label: 'Sync & Deploy', Icon: Rocket, needsCopy: true },
  { id: 'deployments', label: 'Deployments', Icon: Server, needsCopy: false },
];

/**
 * The single top bar of the redesigned shell:
 * BP switcher | Description › Coding Agent ↻ Requirements & tests ›
 * Sync & Deploy › Deployments | copy switcher.
 */
export function TopNav({
  bps,
  activeBpId,
  onSelectBp,
  copy,
  copies,
  onSelectCopy,
  tab,
  onTab,
  role,
}: TopNavProps) {
  const roleMeta = ROLE_META[role] ?? ROLE_META.member;
  return (
    <div className="flex shrink-0 items-center gap-0 border-b border-border bg-background px-6 py-2.5">
      <BpSwitcher
        bps={bps}
        activeBpId={activeBpId}
        onSelect={onSelectBp}
        onCreated={(name) => {
          // Select the new BP and focus its Description tab so the user
          // lands on the spec editor to describe what they're building.
          onSelectBp(name);
          onTab('description');
        }}
        copy={copy}
      />

      <div className="mx-3 h-6 w-px shrink-0 bg-border" aria-hidden />

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {FLOW_STEPS.map((step, i) => {
          const active = tab === step.id;
          const disabled = step.needsCopy && copy === null;
          return (
            <div key={step.id} className="flex shrink-0 items-center gap-1">
              {i > 0 &&
                // The design marks the Agent ↔ Requirements pair with a cycle
                // icon (iterate between them); plain chevrons elsewhere.
                (step.id === 'requirements' ? (
                  <RefreshCw className="size-3 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                ))}
              <button
                type="button"
                onClick={() => !disabled && onTab(step.id)}
                disabled={disabled}
                title={
                  disabled ? 'Create or select a copy first' : step.label
                }
                className={cn(
                  'inline-flex h-[34px] items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors',
                  active
                    ? 'bg-muted font-semibold text-foreground'
                    : 'font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                <step.Icon className="size-3.5" aria-hidden />
                {step.label}
              </button>
            </div>
          );
        })}
      </div>

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
        <CopySwitcher
          copy={copy}
          copies={copies}
          onSelect={onSelectCopy}
        />
      </div>
    </div>
  );
}
