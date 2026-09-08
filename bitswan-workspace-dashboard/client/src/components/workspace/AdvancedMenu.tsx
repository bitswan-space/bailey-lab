import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Plus,
  Settings2,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CopyIdentity } from '@/components/workspace/CopyIdentity';
import { NewExperimentDialog } from '@/components/workspace/NewExperimentDialog';
import { useCopyIdentities } from '@/lib/identity';
import { api, errorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy, EnterCopy } from '@/types';

export interface AdvancedMenuProps {
  copies: Copy[];
  /** The copy in view. */
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  /** The signed-in user's own copy. */
  // eslint-disable-next-line no-restricted-syntax -- null = not yet resolved
  myCopy: string | null;
  /** Every business process on screen — used to pick a replacement when the
   *  one in view can't be materialized in the copy being switched to. */
  bps: BusinessProcess[];
  /** The business process in view — a copy that doesn't carry it yet gets it
   *  materialized before we switch, so the switch lands on a real tree. */
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  selectedBp: BusinessProcess | null;
  /** Move to another copy with the interface locked until it is renderable.
   *  `after` is work that must finish before the lock lifts. */
  onEnterCopy: EnterCopy;
  onSelectBp: (id: string) => void;
  /** Start an experiment on the business process in view (the shell owns the
   *  request and the lock; this menu only opens the dialog). */
  onStartExperiment: (title: string, bp: BusinessProcess) => void;
}

/**
 * The two things you occasionally need that aren't part of the everyday flow:
 * looking at a colleague's version of the process, and running experiments off
 * your own copy. Everything here is driven by explicit copy metadata (kind,
 * owner, parent, bp) plus the AOC directory for display — no name parsing.
 * Copies that carry neither (legacy, operator-created) are deliberately absent;
 * they stay reachable by URL.
 *
 * EXPERIMENTS ARE PER BUSINESS PROCESS. A copy is a person's whole workspace;
 * an experiment is a side branch of ONE business process (each is its own git
 * repository). So this menu only ever lists the experiments belonging to the
 * process on screen — yours, and a colleague's under their expansion. An
 * experiment on something else is not hidden from its owner, it simply lives
 * under that other process, where it means something.
 */
export function AdvancedMenu({
  copies,
  copy,
  myCopy,
  bps,
  selectedBp,
  onEnterCopy,
  onSelectBp,
  onStartExperiment,
}: AdvancedMenuProps) {
  const [open, setOpen] = useState(false);
  const [newExperimentOpen, setNewExperimentOpen] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = nothing expanded
  const [expanded, setExpanded] = useState<string | null>(null);

  // ONLY user copies go to the identity directory: it forward-matches slugs
  // against real people, so an experiment's opaque slug would be misread as
  // one. Experiments are identified by their metadata and shown by title.
  const userCopies = useMemo(
    () => copies.filter((c) => c.kind !== 'experiment'),
    [copies],
  );
  const identities = useCopyIdentities(userCopies.map((c) => c.name));

  // A colleague is anyone else whose copy is explicitly a user copy, or whose
  // slug the directory resolves to a real person (pre-metadata user copies).
  const colleagues = useMemo(
    () =>
      userCopies
        .filter(
          (c) =>
            c.name !== myCopy &&
            (c.kind === 'user' || !!identities[c.name]?.email),
        )
        .sort((a, b) => {
          const an = identities[a.name]?.name || identities[a.name]?.email || a.name;
          const bn = identities[b.name]?.name || identities[b.name]?.email || b.name;
          return an.localeCompare(bn);
        }),
    [userCopies, identities, myCopy],
  );

  // Experiments belonging to the business process ON SCREEN, by parent copy.
  // The filter is a comparison of explicit metadata (`bp`, the directory name
  // gitops recorded when the experiment was created) against the selected
  // process — never a guess from the experiment's slug, which is derived from
  // its title and says nothing about the process.
  const bpName = selectedBp?.name ?? null;
  const experimentsOf = useMemo(() => {
    const byParent = new Map<string, Copy[]>();
    for (const c of copies) {
      if (c.kind !== 'experiment' || !c.parent) continue;
      if (!bpName || c.bp !== bpName) continue;
      const list = byParent.get(c.parent) ?? [];
      list.push(c);
      byParent.set(c.parent, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }
    return byParent;
  }, [copies, bpName]);

  // Experiments started before experiments were per-business-process: gitops
  // never recorded which one they are about and refuses to guess, so they
  // cannot appear under any process. They are shown to their owner anyway,
  // under their own heading — an experiment nobody can find is one nobody can
  // merge back or discard.
  const legacyExperimentsOf = useMemo(() => {
    const byParent = new Map<string, Copy[]>();
    for (const c of copies) {
      if (c.kind !== 'experiment' || !c.parent || !c.bp_legacy) continue;
      const list = byParent.get(c.parent) ?? [];
      list.push(c);
      byParent.set(c.parent, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
    }
    return byParent;
  }, [copies]);

  const myExperiments = (myCopy && experimentsOf.get(myCopy)) || [];
  const myLegacyExperiments = (myCopy && legacyExperimentsOf.get(myCopy)) || [];
  const bpLabel = selectedBp?.displayName ?? selectedBp?.name ?? '';

  // Switching copies keeps the business process in view: clone it into the
  // target copy first when it isn't there yet, so we never land on a copy
  // whose BP tree is missing (lifted from the old copy switcher).
  //
  // The whole thing runs UNDER THE INTERFACE LOCK — the menu closes, the sheet
  // goes up naming where we are going, and it lifts on the far side. There is
  // no in-menu "adding…" row any more: a menu that stays open with one row
  // spinning is the half-state, and the user could click another row inside it.
  //
  // Materializing can legitimately fail — a business process with no content
  // on main has nothing to clone from (gitops 404s), and an experiment refuses
  // any process but its own (409). That is a reason to show a DIFFERENT
  // business process, never a reason to refuse the switch: the user asked to go
  // to that copy, and swallowing the click leaves them wondering why nothing
  // happened.
  const select = (name: string, label: string) => {
    const bpName = selectedBp?.name;
    setOpen(false);
    if (!bpName || selectedBp?.copies.includes(name)) {
      onEnterCopy(name, label);
      return;
    }
    onEnterCopy(name, label, {
      after: () =>
        api.copyFiles
        .ensureBp(name, bpName)
        .then(() => undefined)
        .catch((err: unknown) => {
          const bpLabelText = selectedBp?.displayName ?? bpName;
          // A business process the target copy already carries, if there is one.
          const fallback = bps.find(
            (p) => p.id !== bpName && p.copies.includes(name),
          );
          if (fallback) {
            onSelectBp(fallback.id);
            toast.error(
              `${bpLabelText} isn't available in that copy (${errorMessage(err)}) — ` +
                `showing ${fallback.displayName ?? fallback.name} instead.`,
              { duration: 8000 },
            );
          } else {
            toast.error(
              `${bpLabelText} isn't available in that copy, and it carries no other ` +
                `business process: ${errorMessage(err)}`,
              { duration: 8000 },
            );
          }
          }),
    });
  };

  const sectionLabel = (text: string) => (
    <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {text}
    </div>
  );

  const rowClass = (active: boolean) =>
    cn(
      'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors disabled:opacity-60',
      active ? 'bg-muted' : 'hover:bg-muted/60',
    );

  // Entering an experiment NEVER materializes anything. It already carries the
  // one business process it is about — gitops refuses it any other (409) — so
  // there is nothing to clone and nothing to wait for. The only adjustment is
  // to the process in view, and only for a legacy experiment reached from a
  // different one: an experiment's own process is what it opens on.
  const selectExperiment = (exp: Copy) => {
    if (exp.bp && exp.bp !== bpName) onSelectBp(exp.bp);
    setOpen(false);
    onEnterCopy(exp.name, `Opening the experiment “${exp.title ?? exp.name}”…`);
  };

  const experimentRow = (exp: Copy, indented: boolean) => (
    <button
      key={exp.name}
      type="button"
      onClick={() => selectExperiment(exp)}
      className={cn(rowClass(exp.name === copy), indented && 'pl-8')}
    >
      <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{exp.title ?? exp.name}</span>
      {exp.name === copy ? (
        <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
      ) : null}
    </button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Colleagues' versions and experiments"
            className={cn(
              'inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              open && 'bg-muted/60 text-foreground',
            )}
          >
            <Settings2 className="size-3.5" aria-hidden />
            Advanced
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-80 p-1.5">
          <div className="max-h-96 space-y-0.5 overflow-auto">
            {sectionLabel("See a colleague's version")}
            {colleagues.length === 0 ? (
              <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                No one else has a copy yet.
              </div>
            ) : (
              colleagues.map((c) => {
                const theirExperiments = experimentsOf.get(c.name) ?? [];
                const isExpanded = expanded === c.name;
                return (
                  <div key={c.name}>
                    <div
                      className={cn(
                        'flex h-8 items-center rounded-md transition-colors',
                        c.name === copy ? 'bg-muted' : 'hover:bg-muted/60',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          select(
                            c.name,
                            `Switching to ${identities[c.name]?.name ?? c.name}'s copy…`,
                          )
                        }
                        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left disabled:opacity-60"
                      >
                        <CopyIdentity slug={c.name} className="min-w-0 flex-1" />
                      </button>
                      <div className="flex shrink-0 items-center gap-1 pl-1 pr-1.5">
                        {c.name === copy && (
                          <Check className="size-3.5 text-primary" aria-hidden />
                        )}
                        {theirExperiments.length > 0 && (
                          <button
                            type="button"
                            title={
                              isExpanded
                                ? `Hide their experiments on ${bpLabel}`
                                : `Show their ${theirExperiments.length} experiment(s) on ${bpLabel}`
                            }
                            onClick={() => setExpanded(isExpanded ? null : c.name)}
                            className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-3.5" aria-hidden />
                            ) : (
                              <ChevronRight className="size-3.5" aria-hidden />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    {isExpanded && theirExperiments.map((e) => experimentRow(e, true))}
                  </div>
                );
              })
            )}

            <div className="my-1 h-px bg-border" aria-hidden />

            {sectionLabel(bpLabel ? `Experiments on ${bpLabel}` : 'Experiments')}
            {!myCopy ? (
              <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                Setting up your copy…
              </div>
            ) : (
              <>
                {myExperiments.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    {bpLabel
                      ? `No experiments on ${bpLabel}.`
                      : 'Select a business process to see its experiments.'}
                  </div>
                ) : (
                  myExperiments.map((e) => experimentRow(e, false))
                )}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setNewExperimentOpen(true);
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <Plus className="size-3.5" aria-hidden />
                  Start a new experiment
                </button>

                {/* Experiments from before experiments were per-business
                    process. Which process they are about was never recorded
                    and is NOT guessed, so they belong under no process — but
                    they are still their owner's to merge back or discard, and
                    an experiment that appears in no list is one nobody can end.
                    Labelled, not hidden. */}
                {myLegacyExperiments.length > 0 && (
                  <>
                    {sectionLabel('Started before experiments were per-process')}
                    <div className="px-2.5 pb-1 text-[11px] leading-snug text-muted-foreground">
                      These predate experiments belonging to one business
                      process, so there is no record of which one they are on.
                      Merge back what you want to keep and discard them.
                    </div>
                    {myLegacyExperiments.map((e) => experimentRow(e, false))}
                  </>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* The experiment is started ON the business process in view, and that is
          the only process it will ever hold — gitops refuses it any other
          (409). Switching into it therefore needs no ensureBp: the process we
          just asked for is already there. Opening a DIFFERENT business process
          while inside it LEAVES the experiment (TopNav's process selector). */}
      <NewExperimentDialog
        open={newExperimentOpen}
        onOpenChange={setNewExperimentOpen}
        bp={selectedBp}
        onStart={onStartExperiment}
      />
    </>
  );
}
