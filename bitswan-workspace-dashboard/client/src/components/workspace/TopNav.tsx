import {
  Bot,
  Camera,
  CheckSquare,
  ChevronRight,
  FileText,
  RefreshCw,
  Rocket,
  Server,
  type LucideIcon,
} from 'lucide-react';
import { BpSwitcher } from '@/components/workspace/BpSwitcher';
import { WorktreeSwitcher } from '@/components/workspace/WorktreeSwitcher';
import { cn } from '@/lib/utils';
import type { BusinessProcess, FlowTab, Worktree } from '@/types';

interface TopNavProps {
  bps: BusinessProcess[];
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected yet
  activeBpId: string | null;
  onSelectBp: (id: string) => void;
  // eslint-disable-next-line no-restricted-syntax -- null = no worktree selected
  worktree: string | null;
  worktrees: Worktree[];
  onSelectWorktree: (name: string) => void;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
}

const FLOW_STEPS: {
  id: FlowTab;
  label: string;
  Icon: LucideIcon;
  /** Requires a selected worktree to be usable. */
  needsWorktree: boolean;
}[] = [
  { id: 'description', label: 'Description', Icon: FileText, needsWorktree: false },
  { id: 'agent', label: 'Coding Agent', Icon: Bot, needsWorktree: true },
  {
    id: 'requirements',
    label: 'Requirements & tests',
    Icon: CheckSquare,
    needsWorktree: true,
  },
  { id: 'sync-deploy', label: 'Sync & Deploy', Icon: Rocket, needsWorktree: true },
  { id: 'deployments', label: 'Deployments', Icon: Server, needsWorktree: false },
  { id: 'snapshots', label: 'Snapshots', Icon: Camera, needsWorktree: false },
];

/**
 * The single top bar of the redesigned shell:
 * BP switcher | Description › Coding Agent ↻ Requirements & tests ›
 * Sync & Deploy › Deployments | worktree switcher.
 */
export function TopNav({
  bps,
  activeBpId,
  onSelectBp,
  worktree,
  worktrees,
  onSelectWorktree,
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
        worktree={worktree}
      />

      <div className="mx-3 h-6 w-px shrink-0 bg-border" aria-hidden />

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {FLOW_STEPS.map((step, i) => {
          const active = tab === step.id;
          const disabled = step.needsWorktree && worktree === null;
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
                  disabled ? 'Create or select a worktree first' : step.label
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
        <WorktreeSwitcher
          worktree={worktree}
          worktrees={worktrees}
          onSelect={onSelectWorktree}
        />
      </div>
    </div>
  );
}
