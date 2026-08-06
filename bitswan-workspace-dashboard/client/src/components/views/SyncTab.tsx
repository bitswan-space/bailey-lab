import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Copy } from '@/types';

interface SyncTabProps {
  /** The signed-in user's own copy — the only copy this tab is shown for. */
  wt: Copy;
  /** Pull main into the copy (rebases the whole copy onto main). Resolves when
   *  the pull finishes; conflicts are handled by the caller. */
  onPull: (name: string) => Promise<void>;
  /** Live data says there is nothing to pull. The step only exists because
   *  main has something this copy lacks, so the shell leaves this tab. */
  onNothingToPull: () => void;
}

type Divergence = Record<string, { ahead: number; behind: number }>;

/**
 * The Sync tab — the one-way street from main into your copy. It appears
 * before Description while main carries commits your copy lacks, and
 * disappears the moment it doesn't. Pulling is copy-wide (every business
 * process at once), so the per-BP breakdown here is a description of what
 * arrives, not a set of separate actions.
 */
export function SyncTab({ wt, onPull, onNothingToPull }: SyncTabProps) {
  const [pulling, setPulling] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [divergence, setDivergence] = useState<Divergence | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setDivergence(null);
    setLoadError(null);
    api.copyFiles
      .divergenceAll(wt.name)
      .then((d) => alive && setDivergence(d))
      .catch((err: unknown) => alive && setLoadError(String(err)));
    return () => {
      alive = false;
    };
  }, [wt.name]);

  // One read on entry (and whenever the copy changes); a pull re-reads from its
  // own completion handler below.
  useEffect(() => load(), [load]);

  const handlePull = () => {
    if (pulling) return;
    setPulling(true);
    void Promise.resolve(onPull(wt.name)).finally(() => {
      setPulling(false);
      load();
    });
  };

  const behindBps = Object.entries(divergence ?? {})
    .filter(([, d]) => d.behind > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  // The headline count is the SUM of the live per-business-process readings —
  // there is no snapshot count to compare it against any more. The `copies` SSE
  // event carries cheap filesystem facts only (computing ahead/behind for every
  // copy × every BP cost a fetch per pair on every git event), so this screen's
  // own live read is the ONLY number, and it can't contradict the breakdown
  // underneath it the way the snapshot used to.
  const behindTotal = behindBps.reduce((n, [, d]) => n + d.behind, 0);
  const upToDate = divergence !== null && behindBps.length === 0;

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
            Sync
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            {loadError
              ? `Couldn't read what main has that your copy doesn't: ${loadError}. Pulling is still safe — it replays your work on top of main and does nothing when there is nothing to pull.`
              : divergence === null
                ? `Reading what main has that your copy doesn't…`
                : upToDate
                  ? `Your copy already has everything on main — nothing left to pull. Taking you back to Description.`
                  : `Main has ${behindTotal} change(s) your copy doesn't have yet. Pulling replays your work on top of them, so you build on what everyone else has already delivered. Nothing of yours is published by this — that is what Deploy does.`}
          </p>
        </div>
        {!upToDate && (
          <Button
            size="lg"
            className="shrink-0"
            disabled={pulling}
            title="Pull main's new changes into your copy"
            onClick={handlePull}
          >
            <ArrowDownToLine className="size-4" aria-hidden />
            {pulling ? 'Pulling…' : 'Pull main into my copy'}
          </Button>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl px-7 py-6">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          What arrives
        </div>
        {loadError ? (
          <p className="text-[13px] text-destructive">
            {`Couldn't load the per-process breakdown: ${loadError}`}
          </p>
        ) : divergence === null ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading the per-process breakdown…
          </p>
        ) : behindBps.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No business process in your copy is behind main.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {behindBps.map(([bp, d]) => (
              <li key={bp} className="px-3.5 py-2 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-foreground">{bp}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-amber-600">
                    {`↓ ${d.behind} behind`}
                  </span>
                </div>
                <IncomingCommits copy={wt.name} bp={bp} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The actual incoming commits for one behind business process — main-branch
 * commits whose sha isn't on the copy's branch (within the history cap). This
 * is what makes the Sync tab self-evident: not just "↓ 1 behind" but WHO
 * changed WHAT on main since the copy last pulled.
 */
function IncomingCommits({ copy, bp }: { copy: string; bp: string }) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [incoming, setIncoming] = useState<
    { sha: string; short: string; subject: string; author_name: string }[] | null
  >(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
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
    return <p className="mt-1 text-[12px] text-destructive">{`Couldn't load the commits: ${error}`}</p>;
  if (incoming === null)
    return <p className="mt-1 text-[12px] text-muted-foreground">Loading commits…</p>;
  if (incoming.length === 0) return <></>;
  return (
    <ul className="mt-1.5 space-y-1">
      {incoming.map((c) => (
        <li key={c.sha} className="flex min-w-0 items-baseline gap-2 text-[12px]">
          <span className="shrink-0 font-mono text-muted-foreground">{c.short}</span>
          <span className="min-w-0 truncate text-foreground">{c.subject}</span>
          <span className="shrink-0 text-muted-foreground">{c.author_name}</span>
        </li>
      ))}
    </ul>
  );
}
