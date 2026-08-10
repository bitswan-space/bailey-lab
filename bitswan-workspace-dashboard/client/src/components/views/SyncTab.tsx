import { useEffect, useState } from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type BpDivergence } from '@/lib/api';
import type { BusinessProcess, Copy } from '@/types';

interface SyncTabProps {
  /** The signed-in user's own copy — the only copy this tab is shown for. */
  wt: Copy;
  /** The business process on screen. Sync is scoped to it, exactly like
   *  Deploy: each business process is its own repository. */
  bp: BusinessProcess;
  /** The shell's ONE divergence reading for (copy, business process). null =
   *  not read yet, or the read failed — never 0-as-unknown. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known
  divergence: BpDivergence | null;
  /** Why the reading failed. null = `divergence` is trustworthy. */
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  divergenceError: string | null;
  /** Pull main into THIS business process. Resolves when the pull finishes;
   *  conflicts are handled by the caller (coding-agent handoff). */
  onPull: (copy: string, bp: string, bpLabel: string) => Promise<void>;
  /** Live data says there is nothing to pull for this process. The step only
   *  exists because main has something it lacks, so the shell leaves. */
  onNothingToPull: () => void;
}

/**
 * The Sync tab — the one-way street from main into ONE business process of
 * your copy.
 *
 * It is per business process, mirroring Deploy, because each business process
 * is its own git repository: "behind main" is a fact about a process, never
 * about a copy. As a copy-wide screen it told a user working on `e2eflow1`
 * that main had 21 changes they lacked, and then listed 21 commits from
 * `test33` as what would arrive — true of the copy, meaningless where they
 * were standing. Both of the user's reports about this screen were that.
 *
 * The count, the commits and the pull are all the selected process's. A
 * different process that is behind gets its own Sync step when you go there.
 */
export function SyncTab({
  wt,
  bp,
  divergence,
  divergenceError,
  onPull,
  onNothingToPull,
}: SyncTabProps) {
  const [pulling, setPulling] = useState(false);
  const label = bp.displayName || bp.name;

  const behind = divergence?.behind_bp ?? null;
  // `null` is NOT KNOWN and never 0: "we couldn't read it" must not render as
  // "you are up to date" — the whole reason this screen exists is to be
  // trusted about what arrives.
  const known = behind !== null;
  const upToDate = known && behind === 0;
  // Other processes in this copy that are behind. Named but NOT acted on here:
  // this screen pulls the one you are looking at, and says the rest exist so
  // "no Sync step on e2eflow1" never reads as "nothing to pull anywhere".
  const otherBehind = divergence?.behind_other ?? 0;

  const handlePull = () => {
    if (pulling) return;
    setPulling(true);
    void Promise.resolve(onPull(wt.name, bp.name, label)).finally(() =>
      setPulling(false),
    );
  };

  // Nothing to pull means this step shouldn't exist. Say so, then leave — the
  // short dwell is so the screen doesn't vanish out from under the click that
  // brought the user here.
  useEffect(() => {
    if (!upToDate || pulling) return;
    const t = setTimeout(onNothingToPull, 4000);
    return () => clearTimeout(t);
  }, [upToDate, pulling, onNothingToPull]);

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-background">
      <div className="flex items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <ArrowDownToLine className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">
            {`Sync ${label}`}
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {divergenceError
              ? `Couldn't read what main has that ${label} doesn't: ${divergenceError}. Pulling is still safe — it replays your work on top of main and does nothing when there is nothing to pull.`
              : !known
                ? `Reading what main has that ${label} doesn't…`
                : upToDate
                  ? `${label} already has everything on its main — nothing left to pull. Taking you back to Description.`
                  : `Main has ${behind} change(s) ${label} doesn't have yet. Pulling replays your work on top of them, so you build on what everyone else has already delivered. Nothing of yours is published by this — that is what Deploy does.`}
          </p>
          {/* Each business process is its own repository, so this screen can
              only ever be about one. Saying that another is behind is not an
              action here — it is why the user should not read "up to date" as
              "the whole copy is up to date". */}
          {otherBehind > 0 && (
            <p className="mt-1.5 max-w-xl text-[12px] text-muted-foreground">
              {`Other business processes in your copy are behind main by ${otherBehind} change(s) in total. Each one syncs from its own Sync step — select it in the top bar.`}
            </p>
          )}
        </div>
        {!upToDate && (
          <Button
            size="lg"
            className="shrink-0"
            disabled={pulling}
            title={`Pull main's new changes into ${label}`}
            onClick={handlePull}
          >
            <ArrowDownToLine className="size-4" aria-hidden />
            {pulling ? 'Pulling…' : `Pull main into ${label}`}
          </Button>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl px-7 py-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {`What arrives in ${label}`}
        </div>
        {divergenceError ? (
          <p className="text-[13px] text-destructive">
            {`Couldn't read this business process against main: ${divergenceError}`}
          </p>
        ) : !known ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {`Reading ${label} against main…`}
          </p>
        ) : upToDate ? (
          <p className="text-[13px] text-muted-foreground">
            {`${label} is not behind main.`}
          </p>
        ) : (
          <IncomingCommits copy={wt.name} bp={bp.name} label={label} />
        )}
      </div>
    </div>
  );
}

/**
 * The actual incoming commits for this business process — main-branch commits
 * whose sha isn't on the copy's branch (within the history cap). This is what
 * makes the Sync tab self-evident: not just "↓ 1 behind" but WHO changed WHAT
 * on main since this process last pulled.
 */
function IncomingCommits({
  copy,
  bp,
  label,
}: {
  copy: string;
  bp: string;
  label: string;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [incoming, setIncoming] = useState<
    { sha: string; short: string; subject: string; author_name: string }[] | null
  >(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setIncoming(null);
    setError(null);
    api.copyFiles
      .history(copy, bp)
      .then((h) => {
        if (!alive) return;
        const onCopy = new Set(h.copy.map((c) => c.sha));
        setIncoming(h.main.filter((m) => !onCopy.has(m.sha)));
      })
      .catch((err: unknown) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [copy, bp]);

  if (error)
    return (
      <p className="text-[13px] text-destructive">{`Couldn't load the commits: ${error}`}</p>
    );
  if (incoming === null)
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading the incoming commits…
      </p>
    );
  if (incoming.length === 0)
    return (
      <p className="text-[13px] text-muted-foreground">
        {`Main is ahead of ${label}, but none of its commits are within the history this view reads.`}
      </p>
    );
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {incoming.map((c) => (
        <li
          key={c.sha}
          className="flex min-w-0 items-baseline gap-2 px-3.5 py-2 text-[12px]"
        >
          <span className="shrink-0 font-mono text-muted-foreground">{c.short}</span>
          {/* HISTORICAL GIT DATA, quoted verbatim. Commit subjects gitops
              writes name the business process by its DIRECTORY ("edit
              README.md (test33)") because that is what the repository is
              called — and rewriting somebody's commit message to match a
              display name would be a lie about history. Marked so the "no
              directory slugs in our own copy" check can tell the difference
              between our prose and a quotation. */}
          <span
            data-git-text="subject"
            className="min-w-0 flex-1 truncate text-foreground"
          >
            {c.subject}
          </span>
          <span className="shrink-0 text-muted-foreground">{c.author_name}</span>
        </li>
      ))}
    </ul>
  );
}
