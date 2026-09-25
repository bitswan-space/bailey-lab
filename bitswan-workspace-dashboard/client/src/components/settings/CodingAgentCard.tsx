import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { chooseAgent, useAgentChoice } from '@/hooks/useAgentChoice';
import { AGENT_KINDS, AGENT_KIND_META, type AgentKind } from '@/lib/agentKind';
import { errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';

/**
 * Settings → your coding agent. The same two options the Coding Agent tab
 * offers on first open, with the current one marked. A change takes effect
 * at once: the tab drops the other agent's panels and opens the chosen one.
 */
export function CodingAgentCard() {
  const choice = useAgentChoice();
  const [saving, setSaving] = useState('');
  const current = choice.state === 'chosen' ? choice.kind : '';

  const pick = (kind: AgentKind) => {
    if (saving || kind === current) return;
    setSaving(kind);
    void chooseAgent(kind)
      .then(() => toast.success(`${AGENT_KIND_META[kind].label} is now your coding agent`))
      .catch((err: unknown) => toast.error(`Couldn’t change the coding agent: ${errorMessage(err)}`))
      .finally(() => setSaving(''));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Coding agent</CardTitle>
        <CardDescription>
          Which agent the Coding Agent tab opens for you. This is your own setting; colleagues choose
          theirs. Each agent keeps its own conversations, so switching does not carry them over.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Coding agent">
          {AGENT_KINDS.map((kind) => {
            const meta = AGENT_KIND_META[kind];
            const selected = kind === current;
            const busy = saving === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!!saving || choice.state === 'loading'}
                onClick={() => pick(kind)}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors',
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/60 hover:bg-accent/40',
                  'disabled:cursor-default disabled:opacity-70',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2 text-sm font-semibold text-foreground">
                  {meta.label}
                  {busy ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                  ) : selected ? (
                    <Check className="size-4 text-primary" aria-hidden />
                  ) : undefined}
                </span>
                <span className="text-xs font-medium text-primary">{meta.tagline}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{meta.description}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          OpenCode runs as a server of your own inside the coding-agent container and is reached only
          through this dashboard; its own “add server” setting cannot be used here. Idle servers are
          stopped after a while and started again on your next visit.
        </p>
      </CardContent>
    </Card>
  );
}
