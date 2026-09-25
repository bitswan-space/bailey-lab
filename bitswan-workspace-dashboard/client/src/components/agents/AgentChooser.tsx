import { useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { chooseAgent } from '@/hooks/useAgentChoice';
import { AGENT_KINDS, AGENT_KIND_META, type AgentKind } from '@/lib/agentKind';
import { errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

/**
 * The first thing the Coding Agent tab shows a person who has not picked an
 * agent yet: Claude Code or OpenCode, one card each. The choice is saved to
 * their profile and the panel for it takes the pane's place; Settings changes
 * it later.
 */
export function AgentChooser() {
  // Which card is being saved, '' when none — a plain string keeps the state
  // discriminated without a nullable type.
  const [saving, setSaving] = useState('');

  const pick = (kind: AgentKind) => {
    if (saving) return;
    setSaving(kind);
    void chooseAgent(kind)
      .catch((err: unknown) => {
        toast.error(`Couldn’t save your choice: ${errorMessage(err)}`);
      })
      .finally(() => setSaving(''));
  };

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-6">
      <div className="w-full max-w-2xl space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
            <Bot className="size-5 text-primary" aria-hidden />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-foreground">Which coding agent do you want to work with?</div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Both run inside this workspace’s coding-agent container, on the business process you have
              open. You can change this later in Settings.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_KINDS.map((kind) => {
            const meta = AGENT_KIND_META[kind];
            const busy = saving === kind;
            return (
              <button
                key={kind}
                type="button"
                disabled={!!saving}
                onClick={() => pick(kind)}
                className={cn(
                  'flex flex-col items-start gap-2 rounded-lg border border-border bg-background p-4 text-left transition-colors',
                  'hover:border-primary/60 hover:bg-accent/40 disabled:cursor-default disabled:opacity-70',
                )}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                  {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
                </div>
                <span className="text-xs font-medium text-primary">{meta.tagline}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{meta.description}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
