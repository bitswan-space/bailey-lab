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
import type { BusinessProcess, Copy } from '@/types';

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
  onSelectCopy: (name: string) => void;
  onSelectBp: (id: string) => void;
}

/**
 * The two things you occasionally need that aren't part of the everyday flow:
 * looking at a colleague's version of the process, and running experiments off
 * your own copy. Everything here is driven by explicit copy metadata (kind,
 * owner, parent) plus the AOC directory for display — no name parsing. Copies
 * that carry neither (legacy, operator-created) are deliberately absent; they
 * stay reachable by URL.
 */
export function AdvancedMenu({
  copies,
  copy,
  myCopy,
  bps,
  selectedBp,
  onSelectCopy,
  onSelectBp,
}: AdvancedMenuProps) {
  const [open, setOpen] = useState(false);
  const [newExperimentOpen, setNewExperimentOpen] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = nothing expanded
  const [expanded, setExpanded] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no materialize in flight
  const [materializing, setMaterializing] = useState<string | null>(null);

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

  const experimentsOf = useMemo(() => {
    const byParent = new Map<string, Copy[]>();
    for (const c of copies) {
      if (c.kind !== 'experiment' || !c.parent) continue;
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

  // Switching copies keeps the business process in view: clone it into the
  // target copy first when it isn't there yet, so we never land on a copy
  // whose BP tree is missing (lifted from the old copy switcher).
  //
  // Materializing can legitimately fail — a business process with no content
  // on main has nothing to clone from (gitops 404s). That is a reason to pick
  // a DIFFERENT business process, never a reason to refuse the switch: the
  // user asked to go to that copy, and swallowing the click leaves them
  // wondering why nothing happened.
  const select = (name: string) => {
    if (materializing) return;
    const bpName = selectedBp?.name;
    if (!bpName || selectedBp?.copies.includes(name)) {
      onSelectCopy(name);
      setOpen(false);
      return;
    }
    setMaterializing(name);
    api.copyFiles
      .ensureBp(name, bpName)
      .then(() => {
        onSelectCopy(name);
        setOpen(false);
      })
      .catch((err: unknown) => {
        const label = selectedBp?.displayName ?? bpName;
        // A business process the target copy already carries, if there is one.
        const fallback = bps.find((p) => p.id !== bpName && p.copies.includes(name));
        onSelectCopy(name);
        setOpen(false);
        if (fallback) {
          onSelectBp(fallback.id);
          toast.error(
            `${label} isn't available in that copy (${errorMessage(err)}) — ` +
              `showing ${fallback.displayName ?? fallback.name} instead.`,
            { duration: 8000 },
          );
        } else {
          toast.error(
            `${label} isn't available in that copy, and it carries no other ` +
              `business process: ${errorMessage(err)}`,
            { duration: 8000 },
          );
        }
      })
      .finally(() => setMaterializing(null));
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

  const experimentRow = (exp: Copy, indented: boolean) => (
    <button
      key={exp.name}
      type="button"
      disabled={materializing !== null}
      onClick={() => select(exp.name)}
      className={cn(rowClass(exp.name === copy), indented && 'pl-8')}
    >
      <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{exp.title ?? exp.name}</span>
      {materializing === exp.name ? (
        <span className="text-[10px] text-muted-foreground">adding…</span>
      ) : exp.name === copy ? (
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
                        disabled={materializing !== null}
                        onClick={() => select(c.name)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left disabled:opacity-60"
                      >
                        <CopyIdentity slug={c.name} className="min-w-0 flex-1" />
                      </button>
                      <div className="flex shrink-0 items-center gap-1 pl-1 pr-1.5">
                        {materializing === c.name && (
                          <span className="text-[10px] text-muted-foreground">
                            adding…
                          </span>
                        )}
                        {c.name === copy && (
                          <Check className="size-3.5 text-primary" aria-hidden />
                        )}
                        {theirExperiments.length > 0 && (
                          <button
                            type="button"
                            title={
                              isExpanded
                                ? 'Hide their experiments'
                                : `Show their ${theirExperiments.length} experiment(s)`
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

            {sectionLabel('Experiments')}
            {!myCopy ? (
              <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                Setting up your copy…
              </div>
            ) : (
              <>
                {myExperiments.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    You have no experiments running.
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
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* The experiment is started ON the business process in view — the only
          one cloned into it. Switching into it therefore needs no ensureBp: the
          BP we just asked for is already there, so we select it straight away
          instead of waiting on a round trip that would answer `already: true`.
          Opening a DIFFERENT business process inside the experiment is what
          materializes that one, on demand (TopNav's BP selector). */}
      <NewExperimentDialog
        open={newExperimentOpen}
        onOpenChange={setNewExperimentOpen}
        bp={selectedBp}
        onCreated={(name) => onSelectCopy(name)}
      />
    </>
  );
}
