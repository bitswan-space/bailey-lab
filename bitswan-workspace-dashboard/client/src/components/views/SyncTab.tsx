import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDownToLine, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffFileList } from '@/components/diff/DiffFileList';
import { DiffView } from '@/components/diff/DiffView';
import { RelativeTime } from '@/components/shared/RelativeTime';
import { api, errorMessage, type BpDivergence, type Incoming } from '@/lib/api';
import { cn } from '@/lib/utils';
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
 *
 * WHAT IT SHOWS is the second thing the user reported (#357, with a
 * screenshot): a flat scroll of commit subjects and nothing else. On a
 * workspace where everybody edits the same file that is thirty rows reading
 * "edit README.md" — a screen that says how many changes are coming and
 * refuses to say what they are, which is the only question anyone opens it to
 * answer. So it leads with the FILES the pull changes, each one clickable
 * straight to its diff, and keeps the commits as the second view for "who
 * changed this, and when".
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-start gap-4 border-b border-border bg-background px-7 py-6">
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

      {divergenceError ? (
        <p className="px-7 py-6 text-[13px] text-destructive">
          {`Couldn't read this business process against main: ${divergenceError}`}
        </p>
      ) : !known ? (
        <p className="flex items-center gap-2 px-7 py-6 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {`Reading ${label} against main…`}
        </p>
      ) : upToDate ? (
        <p className="px-7 py-6 text-[13px] text-muted-foreground">
          {`${label} is not behind main.`}
        </p>
      ) : (
        <IncomingPanel copy={wt.name} bp={bp.name} label={label} />
      )}
    </div>
  );
}

/** Which pane of the left rail is showing, and what the diff pane is for. */
type Selection =
  | { view: 'files'; path?: string }
  | { view: 'commits'; sha?: string; short?: string; subject?: string };

/**
 * Everything the pull brings in: a rail listing it, and the diff for whichever
 * row is selected.
 *
 * `files` is the default view because it is the answer to "what changes" — the
 * question the commit-only version of this screen could not answer. Selecting
 * nothing shows the WHOLE incoming diff rather than an empty pane, so the
 * screen has a diff on it the moment it opens.
 */
function IncomingPanel({
  copy,
  bp,
  label,
}: {
  copy: string;
  bp: string;
  label: string;
}) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ view: 'files' });
  const [diff, setDiff] = useState('');
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setIncoming(null);
    setError(null);
    setSelection({ view: 'files' });
    api.copyFiles
      .incoming(copy, bp)
      .then((r) => {
        if (!alive) return;
        setIncoming(r);
        // Land on the FIRST FILE, not on "everything": a pull left for a month
        // is a diff of megabytes, and opening a step by rendering all of it is
        // how a screen becomes something people avoid. One file is instant,
        // and "Everything arriving" is the row above it.
        setSelection({ view: 'files', ...(r.files[0] && { path: r.files[0].path }) });
      })
      // eslint-disable-next-line no-restricted-syntax -- catch parameter is genuinely unknown
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [copy, bp]);

  // The diff for the current selection. A commit's diff comes from `git show`
  // on that one commit; everything else is the incoming RANGE, whole or for
  // one file — the same range the file list was counted from, so the numbers
  // in the rail and the lines in the pane can't describe different things.
  useEffect(() => {
    // Wait for the summary: it is what picks the opening selection, and asking
    // for the whole-range diff in the meantime is a request whose answer we
    // would throw away a moment later.
    if (incoming === null) return;
    let alive = true;
    setDiffLoading(true);
    setDiffTruncated(false);
    const request =
      selection.view === 'commits' && selection.sha
        ? api.copyFiles.commitDiff(copy, selection.sha, bp).then((r) => ({
            diff: r.diff,
            truncated: false,
          }))
        : api.copyFiles.incomingDiff(
            copy,
            bp,
            selection.view === 'files' ? selection.path : undefined,
          );
    request
      .then((r) => {
        if (!alive) return;
        setDiff(r.diff);
        setDiffTruncated(r.truncated);
      })
      .catch(() => {
        if (alive) setDiff('');
      })
      .finally(() => {
        if (alive) setDiffLoading(false);
      });
    return () => {
      alive = false;
    };
    // `incoming` is a gate, not an input: only its arrival matters, and the
    // selection it sets is what actually drives the request.
  }, [copy, bp, selection, incoming]);

  const totals = useMemo(() => {
    const files = incoming?.files ?? [];
    return {
      adds: files.reduce((a, f) => a + f.adds, 0),
      dels: files.reduce((a, f) => a + f.dels, 0),
    };
  }, [incoming]);

  if (error)
    return (
      <p className="px-7 py-6 text-[13px] text-destructive">
        {`Couldn't read what would arrive in ${label}: ${error}`}
      </p>
    );
  if (incoming === null)
    return (
      <p className="flex items-center gap-2 px-7 py-6 text-[13px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {`Reading what would arrive in ${label}…`}
      </p>
    );
  // Main is ahead by the divergence reading, but this process's incoming range
  // is empty. Real (a merge commit whose content is already here), and not an
  // error — say what it means for the pull rather than showing an empty rail.
  if (incoming.files.length === 0 && incoming.commits.length === 0)
    return (
      <p className="px-7 py-6 text-[13px] text-muted-foreground">
        {`Main is ahead of ${label}, but none of it changes any file here — ` +
          `pulling moves ${label} onto main's history and leaves your files as they are.`}
      </p>
    );

  const { commits, files } = incoming;
  // Switching rails lands on that rail's first row for the same reason opening
  // the screen does: a real, bounded diff beats the whole range.
  const showFiles = () =>
    setSelection({ view: 'files', ...(files[0] && { path: files[0].path }) });
  const showCommits = () => {
    const first = commits[0];
    setSelection(
      first
        ? {
            view: 'commits',
            sha: first.sha,
            short: first.short,
            subject: first.subject,
          }
        : { view: 'commits' },
    );
  };
  const diffTitle =
    selection.view === 'commits' && selection.sha
      ? `${selection.short} · ${selection.subject}`
      : selection.view === 'files' && selection.path
        ? selection.path
        : `Everything arriving in ${label}`;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-80 min-w-0 shrink-0 flex-col border-r border-border">
        <div className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
          <RailTab active={selection.view === 'files'} onClick={showFiles}>
            {`${files.length} file${files.length === 1 ? '' : 's'}`}
          </RailTab>
          <RailTab active={selection.view === 'commits'} onClick={showCommits}>
            {`${commits.length}${incoming.commits_truncated ? '+' : ''} commit${
              commits.length === 1 ? '' : 's'
            }`}
          </RailTab>
          <span className="ml-auto self-center text-[11px] tabular-nums">
            {totals.adds > 0 ? (
              <span className="text-emerald-600">+{totals.adds}</span>
            ) : null}
            {totals.adds > 0 && totals.dels > 0 ? ' ' : ''}
            {totals.dels > 0 ? (
              <span className="text-red-600">−{totals.dels}</span>
            ) : null}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {selection.view === 'files' ? (
            <>
              <RailAllRow
                active={selection.path === undefined}
                onClick={() => setSelection({ view: 'files' })}
                label={`Everything arriving in ${label}`}
              />
              <DiffFileList
                files={files}
                selectedPath={selection.path ?? null}
                onSelect={(path) => setSelection({ view: 'files', path })}
              />
            </>
          ) : (
            <CommitRail
              commits={commits}
              truncated={incoming.commits_truncated}
              selectedSha={selection.view === 'commits' ? selection.sha : undefined}
              onSelect={(c) =>
                setSelection({
                  view: 'commits',
                  sha: c.sha,
                  short: c.short,
                  subject: c.subject,
                })
              }
              onSelectAll={() => setSelection({ view: 'commits' })}
              allLabel={`Everything arriving in ${label}`}
            />
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DiffView path={diffTitle} diff={diff} loading={diffLoading} />
        {diffTruncated ? (
          <p className="shrink-0 border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
            This diff is too large to show in full. Open a single file from the
            list to see all of its changes.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RailTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60',
      )}
    >
      {children}
    </button>
  );
}

/** The "show me all of it" row that sits above either rail list. */
function RailAllRow({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[12px] font-medium transition-colors',
        active ? 'bg-muted/60' : 'hover:bg-muted/30',
      )}
    >
      <ArrowDownToLine className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * The commits arriving, newest first. Kept as the SECOND view: it answers "who
 * changed this and when", which matters once you know what changed — and on
 * its own, which is all this screen used to show, it answers neither.
 */
function CommitRail({
  commits,
  truncated,
  selectedSha,
  onSelect,
  onSelectAll,
  allLabel,
}: {
  commits: Incoming['commits'];
  truncated: boolean;
  selectedSha?: string;
  onSelect: (c: Incoming['commits'][number]) => void;
  onSelectAll: () => void;
  allLabel: string;
}) {
  return (
    <div className="flex flex-col">
      <RailAllRow
        active={selectedSha === undefined}
        onClick={onSelectAll}
        label={allLabel}
      />
      {commits.map((c) => (
        <button
          key={c.sha}
          type="button"
          onClick={() => onSelect(c)}
          className={cn(
            'flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2 text-left transition-colors',
            selectedSha === c.sha ? 'bg-muted/60' : 'hover:bg-muted/30',
          )}
        >
          <GitCommitHorizontal
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            {/* HISTORICAL GIT DATA, quoted verbatim. Commit subjects gitops
                writes name the business process by its DIRECTORY ("edit
                README.md (test33)") because that is what the repository is
                called — and rewriting somebody's commit message to match a
                display name would be a lie about history. Marked so the "no
                directory slugs in our own copy" check can tell the difference
                between our prose and a quotation. */}
            <span
              data-git-text="subject"
              className="block truncate text-[12px] text-foreground"
              title={c.subject}
            >
              {c.subject}
            </span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">{c.author_name}</span>
              <span aria-hidden>·</span>
              <RelativeTime value={c.date} variant="short" />
              <span className="ml-auto shrink-0 font-mono">{c.short}</span>
            </span>
          </span>
        </button>
      ))}
      {truncated ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">
          Older commits are not listed. The file list above covers all of them.
        </p>
      ) : null}
    </div>
  );
}
