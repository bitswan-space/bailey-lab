import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  GitBranch,
  Loader2,
  Plus,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { NewCopyDialog } from '@/components/workspace/NewCopyDialog';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy } from '@/types';

type Delta = { ahead: number; behind: number };

/**
 * How the selected business process in a given copy diverges from main: `↑N`
 * ahead (changes here not yet published — via Sync & Deploy), `↓N` behind
 * (changes on main not yet pulled). The ↓ chip is the only actionable one —
 * clicking it pulls main into the WHOLE copy (the pull is copy-wide; it's just
 * surfaced against the BP in view). In step with main → a check; not-yet-loaded
 * counts reserve their space silently.
 */
function CopyDelta({
  d,
  fetched,
  pulling,
  onPull,
}: {
  d?: Delta;
  fetched: boolean;
  pulling: boolean;
  onPull: () => void;
}) {
  if (!fetched) return <span className="size-3" aria-hidden />;
  const ahead = d?.ahead ?? 0;
  const behind = d?.behind ?? 0;
  if (!ahead && !behind) {
    return <Check className="size-3 shrink-0 text-emerald-500" aria-hidden />;
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold tabular-nums">
      {ahead > 0 && (
        <span
          title={`${ahead} change(s) to this business process in this copy not yet in main`}
          className="inline-flex items-center gap-0.5 text-muted-foreground"
        >
          <ArrowUp className="size-3" aria-hidden />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <button
          type="button"
          disabled={pulling}
          title={`Pull ${behind} new change(s) from main — rebases the whole copy onto main`}
          onClick={(e) => {
            e.stopPropagation();
            onPull();
          }}
          className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-amber-700 transition-colors hover:bg-amber-500/30 disabled:opacity-60"
        >
          {pulling ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          )}
          {behind}
        </button>
      )}
    </span>
  );
}

interface CopySelectorProps {
  copies: Copy[];
  /** The business process currently in view — the copy list is scoped to the
   *  copies that carry it ("first the process, then the copy"). */
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  selectedBp: BusinessProcess | null;
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  onSelect: (name: string) => void;
  /** Pull main into a copy (rebase it onto main). Resolves when done. */
  onPull: (name: string) => Promise<void>;
  onCreatedCopy: (name: string) => void;
}

/**
 * The copy picker — your working environment for the selected business process.
 * Subordinate to the BP: it lists only the copies that carry the BP in view,
 * each with how that BP diverges from main there, and a one-click pull. This
 * selector anchors the "copy region" card in the top bar: everything up to
 * Sync & Deploy happens inside the chosen copy.
 *
 * No "Delete copy" action — a copy is the user's personal working environment
 * and the dashboard must never delete it; cleanup is operator-only.
 */
export function CopySelector({
  copies,
  selectedBp,
  copy,
  onSelect,
  onPull,
  onCreatedCopy,
}: CopySelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // eslint-disable-next-line no-restricted-syntax -- null = no pull in flight
  const [pulling, setPulling] = useState<string | null>(null);
  const [newCopyOpen, setNewCopyOpen] = useState(false);
  // Per-(BP, copy) ahead/behind, keyed by copy then BP dir. A copy key present
  // means it's been fetched (value may be {} = nothing diverges).
  const [divergence, setDivergence] = useState<
    Record<string, Record<string, Delta>>
  >({});
  const pendingDivergence = useRef<Set<string>>(new Set());

  const activeCopy = copies.find((c) => c.name === copy) ?? null;
  const bpName = selectedBp?.name;

  // Copies that carry the selected BP.
  const bpCopies = useMemo(() => {
    if (!selectedBp) return [];
    return copies
      .filter((c) => selectedBp.copies.includes(c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [copies, selectedBp]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? bpCopies.filter((c) => c.name.toLowerCase().includes(q))
    : bpCopies;

  useEffect(() => {
    if (open) setQuery('');
    else setDivergence({});
  }, [open]);

  // Fetch per-(BP, copy) divergence for the listed copies on open (one git
  // fetch per copy, cached). Best-effort: on error mark fetched-empty.
  useEffect(() => {
    if (!open) return;
    for (const c of bpCopies) {
      if (divergence[c.name] !== undefined) continue;
      if (pendingDivergence.current.has(c.name)) continue;
      pendingDivergence.current.add(c.name);
      api.copyFiles
        .divergenceAll(c.name)
        .then((d) => setDivergence((prev) => ({ ...prev, [c.name]: d })))
        .catch(() => setDivergence((prev) => ({ ...prev, [c.name]: {} })))
        .finally(() => pendingDivergence.current.delete(c.name));
    }
  }, [open, bpCopies, divergence]);

  const handlePull = (name: string) => {
    if (pulling) return;
    setPulling(name);
    void Promise.resolve(onPull(name)).finally(() => {
      setPulling(null);
      setDivergence((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    });
  };

  // Always-available copy-level behind hint on the trigger (from the SSE
  // snapshot), so "this copy has changes to pull" is visible without opening.
  const triggerBehind = activeCopy?.behind ?? 0;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Switch copy (your working environment for this process)"
            className={cn(
              'inline-flex h-[34px] max-w-64 items-center gap-2 rounded-lg border bg-background py-0 pl-3 pr-2.5 transition-colors hover:bg-muted/60',
              activeCopy ? 'border-primary' : 'border-border',
              open && 'bg-muted/60',
            )}
          >
            <GitBranch
              className={cn(
                'size-3.5 shrink-0',
                activeCopy ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Copy
            </span>
            <span className="max-w-40 truncate font-mono text-[13px] font-semibold text-foreground">
              {activeCopy?.name ?? '—'}
            </span>
            {triggerBehind > 0 && (
              <span
                title={`${triggerBehind} change(s) on main to pull into this copy`}
                className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-semibold tabular-nums text-amber-700"
              >
                <ArrowDown className="size-3" aria-hidden />
                {triggerBehind}
              </span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-80 p-0">
          <div className="border-b border-border p-1.5">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search copies…"
              spellCheck={false}
              autoComplete="off"
              className="h-8"
            />
          </div>
          <div className="max-h-72 space-y-0.5 overflow-auto p-1.5">
            {!selectedBp ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                Select a business process first
              </div>
            ) : bpCopies.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                This business process isn’t in any copy yet
              </div>
            ) : visible.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                No matches
              </div>
            ) : (
              visible.map((c) => {
                const active = c.name === copy;
                const fetched = divergence[c.name] !== undefined;
                return (
                  <div
                    key={c.name}
                    className={cn(
                      'flex h-8 items-center rounded-md transition-colors',
                      active ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(c.name);
                        setOpen(false);
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left"
                    >
                      <GitBranch
                        className={cn(
                          'size-3.5 shrink-0',
                          active ? 'text-primary' : 'text-muted-foreground',
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                        {c.name}
                      </span>
                    </button>
                    {/* Sibling of the select button (not nested) so the ↓ pull
                        is a valid standalone button; reserved check slot keeps
                        the chips aligned. */}
                    <div className="flex shrink-0 items-center gap-1.5 pr-2.5 pl-1">
                      <CopyDelta
                        d={bpName ? divergence[c.name]?.[bpName] : undefined}
                        fetched={fetched}
                        pulling={pulling === c.name}
                        onPull={() => handlePull(c.name)}
                      />
                      <span className="flex size-3.5 items-center justify-center">
                        {active && (
                          <Check className="size-3.5 text-primary" aria-hidden />
                        )}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setNewCopyOpen(true);
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="size-3.5" aria-hidden />
              New copy
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <NewCopyDialog
        open={newCopyOpen}
        onOpenChange={setNewCopyOpen}
        existingNames={copies.map((c) => c.name)}
        onCreated={(name) => onCreatedCopy(name)}
      />
    </>
  );
}
