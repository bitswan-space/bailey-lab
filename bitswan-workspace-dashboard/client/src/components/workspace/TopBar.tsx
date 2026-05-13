import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, Plus, Rocket, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, isTransientNetworkError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Scope, Worktree } from '@/types';

// Gitops's worktree-name allowlist (mirrors `_WORKTREE_NAME_RE` in
// bitswan-gitops/app/routes/worktrees.py:_WORKTREE_NAME_RE). Kept here so we
// can give the user immediate feedback in the dialog rather than waiting
// for a 400 round-trip.
const WORKTREE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

interface TopBarProps {
  scope: Scope;
  onScope: (s: Scope) => void;
  worktrees: Worktree[];
}

export function TopBar({ scope, onScope, worktrees }: TopBarProps) {
  const isDeployments = scope.type === 'deployments';
  const [dialogOpen, setDialogOpen] = useState(false);

  // Track horizontal scroll state so the edge fades only render on sides
  // that actually have hidden content. Without this, the first/last tab
  // would always look dimmed even when nothing's clipped.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [worktrees]);

  // Switch to the freshly-created worktree on success. The SSE feed will
  // surface it in the `worktrees` snapshot shortly after; until that
  // arrives, the user sees the loading state on the worktree tab content,
  // which is fine.
  const handleCreated = useCallback(
    (name: string) => {
      onScope({ type: 'worktree', name });
    },
    [onScope],
  );

  return (
    <div className="flex items-stretch border-b border-border bg-background pt-3.5">
      {/* Deployments tab stays anchored on the left — outside the scroller
          so it never disappears off-screen no matter how many worktrees
          the user has. */}
      <div className="flex shrink-0 items-stretch pl-6">
        <SwitchTab
          active={isDeployments}
          onClick={() => onScope({ type: 'deployments' })}
          Icon={Rocket}
          label="Deployments"
          sub="dev · staging · production"
        />
        {worktrees.length > 0 && (
          <div
            className="my-2 ml-3 w-px shrink-0 self-stretch bg-border"
            aria-hidden
          />
        )}
      </div>
      {/* Only the worktree tabs scroll. Fade-left/right classes are driven
          by the scroll position so the edge indicators only appear when
          there's content actually hidden on that side. */}
      <div
        ref={scrollerRef}
        className={cn(
          'topbar-scroller flex flex-1 items-stretch gap-0 overflow-x-auto px-3',
          canScrollLeft && 'fade-left',
          canScrollRight && 'fade-right',
        )}
      >
        {worktrees.map((wt) => {
          const active = scope.type === 'worktree' && scope.name === wt.name;
          return (
            <SwitchTab
              key={wt.name}
              active={active}
              onClick={() => onScope({ type: 'worktree', name: wt.name })}
              Icon={GitBranch}
              label={wt.name}
              sub={wt.synced ? 'synced' : 'unsynced'}
              tone={wt.synced ? 'success' : 'warning'}
            />
          );
        })}
      </div>
      <div className="flex shrink-0 items-center border-l border-border bg-background pl-3 pr-6 pb-2.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          className="gap-1.5"
        >
          <Plus className="size-3.5" aria-hidden />
          New worktree
        </Button>
      </div>
      <NewWorktreeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        existingNames={worktrees.map((w) => w.name)}
        onCreated={handleCreated}
      />
    </div>
  );
}

interface SwitchTabProps {
  active: boolean;
  onClick: () => void;
  Icon: LucideIcon;
  label: string;
  sub?: string;
  tone?: 'default' | 'success' | 'warning';
}

function SwitchTab({ active, onClick, Icon, label, sub, tone = 'default' }: SwitchTabProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // 2-col grid: icon column (auto) + label/sub column (1fr). The sub-label
        // lives in row 2 col 2 — naturally aligned under the label without a
        // hand-tuned padding offset.
        'grid min-w-32 shrink-0 grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-0.5 border-b-2 px-3.5 pb-2.5 pt-2 transition-colors',
        active
          ? 'border-primary bg-background'
          : 'border-transparent text-zinc-600 hover:bg-muted/40',
      )}
    >
      <Icon
        className={cn('size-3.5', active ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden
      />
      <span
        className={cn(
          'text-left text-sm',
          active ? 'font-semibold text-foreground' : 'font-medium',
        )}
      >
        {label}
      </span>
      {sub && (
        <span
          className={cn(
            'col-start-2 text-left text-xs font-medium',
            tone === 'success'
              ? 'text-emerald-600'
              : tone === 'warning'
                ? 'text-amber-600'
                : 'text-muted-foreground',
          )}
        >
          {sub}
        </span>
      )}
    </button>
  );
}

interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onCreated: (name: string) => void;
}

function NewWorktreeDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
}: NewWorktreeDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  // eslint-disable-next-line no-restricted-syntax -- error message; null = "no error"
  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = null; // empty input is just "not ready yet"
  } else if (!WORKTREE_NAME_RE.test(trimmed)) {
    validationError =
      'Use letters, digits and hyphens only. Must start with a letter or digit.';
  } else if (existingNames.includes(trimmed)) {
    validationError = `A worktree named "${trimmed}" already exists.`;
  }
  const canSubmit = trimmed.length > 0 && !validationError && !submitting;

  const reset = useCallback(() => {
    setName('');
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      const work = api.createWorktree({ branch_name: trimmed });
      toast.promise(work, {
        loading: `Creating worktree "${trimmed}"…`,
        success: `Worktree "${trimmed}" created`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `Worktree "${trimmed}" created`
            : `Failed to create worktree: ${String(err)}`,
      });
      try {
        await work;
        onOpenChange(false);
        reset();
        onCreated(trimmed);
      } catch {
        // already reported via toast.promise
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, trimmed, onOpenChange, reset, onCreated],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Creates a new git worktree under <code>worktrees/</code> with a
            branch of the same name, branched off the current main HEAD.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="new-worktree-name" className="text-sm font-medium">
            Branch name
          </label>
          <Input
            id="new-worktree-name"
            autoFocus
            placeholder="my-feature"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
          )}
        </form>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
