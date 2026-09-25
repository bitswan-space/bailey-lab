import { Settings, ShieldCheck } from 'lucide-react';
import { CodingAgentCard } from '@/components/settings/CodingAgentCard';
import { GitRemoteCard } from '@/components/settings/GitRemoteCard';
import type { FlowTab } from '@/types';

interface SettingsTabProps {
  role: 'admin' | 'auditor' | 'member';
  onTab: (t: FlowTab) => void;
}

/**
 * Settings: the person's own preferences first (every role has those), then
 * the workspace-wide settings only an admin may change.
 */
export function SettingsTab({ role }: SettingsTabProps) {
  const admin = role === 'admin';
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <Settings className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">Settings</div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {admin
              ? 'Your own preferences, then the admin-only settings for this workspace. The steps in the top bar take you back to your work.'
              : 'Your own preferences. The steps in the top bar take you back to your work.'}
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-7 py-6">
          <CodingAgentCard />
          {admin ? (
            <GitRemoteCard />
          ) : (
            <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Workspace settings — including the git remote mirror — can only be changed by an admin.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
