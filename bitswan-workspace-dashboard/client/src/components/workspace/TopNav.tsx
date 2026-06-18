import {
  Bot,
  CheckSquare,
  ChevronRight,
  FileText,
  RefreshCw,
  Rocket,
  Server,
  type LucideIcon,
} from 'lucide-react';
import { BpSwitcher } from '@/components/workspace/BpSwitcher';
import { CopySwitcher } from '@/components/workspace/CopySwitcher';
import { cn } from '@/lib/utils';
import type { BusinessProcess, FlowTab, Copy } from '@/types';

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
}: TopNavProps) {
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

      <div className="ml-auto shrink-0 pl-3">
        <CopySwitcher
          copy={copy}
          copies={copies}
          onSelect={onSelectCopy}
        />
      </div>
    </div>
  );
}
