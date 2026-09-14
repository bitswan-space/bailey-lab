import { Settings, ShieldCheck } from 'lucide-react';
import { GitRemoteCard } from '@/components/settings/GitRemoteCard';
import { Button } from '@/components/ui/button';
import type { FlowTab } from '@/types';

interface SettingsTabProps {
  role: 'admin' | 'auditor' | 'member';
  onTab: (t: FlowTab) => void;
}

const ROLE_LABEL: Record<SettingsTabProps['role'], string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  member: 'Member',
};

export function SettingsTab({ role, onTab }: SettingsTabProps) {
  if (role !== 'admin') {
    return (
      <div className="flex flex-1 items-center justify-center bg-background p-8">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-[10px] bg-primary/10">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
          </div>
          <div className="text-[15px] font-semibold text-foreground">Admins only</div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {`Workspace settings — including the git remote mirror — can only be changed by an admin. Your role is ${ROLE_LABEL[role]}.`}
          </p>
          <Button size="sm" variant="outline" onClick={() => onTab('description')}>
            Back to Description
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <Settings className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">
            Workspace settings
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Admin-only settings for this workspace. The steps in the top bar take you back to
            your work.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-7 py-6">
          <GitRemoteCard />
        </div>
      </div>
    </div>
  );
}
