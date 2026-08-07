import { useEffect } from 'react';
import { ArrowLeft, FlaskConical, GitMerge, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMergePreview } from '@/hooks/useMergePreview';
import type { Copy } from '@/types';

export interface ExperimentBannerProps {
  /** The experiment in view — always one the signed-in user owns. */
  copy: Copy;
  /** Display name of the ONE business process this experiment is on, resolved
   *  from `copy.bp`. Empty for a legacy experiment, whose process was never
   *  recorded — the banner then says so rather than naming a guess. */
  bpLabel: string;
  /** Step OUT of the experiment and back to the copy it branched from,
   *  leaving it exactly as it is. Not an ending — the counterpart to picking
   *  it again under Advanced → Experiments. */
  onLeave: () => void;
  /** Fast-forward the experiment's work into the parent copy. */
  onMergeBack: () => void;
  /** Open the discard (delete) confirmation for this experiment. */
  onDiscard: () => void;
  /** A merge-back is in flight. */
  merging: boolean;
  /** Bumped by the shell whenever an editor save lands in this copy, so the
   *  dirtiness check refetches immediately instead of waiting for a window
   *  refocus. */
  refreshKey?: number;
}

/**
 * The "you are somewhere else" banner for your own experiment: a side branch
 * off your copy, on ONE business process, that merges back into your copy
 * (never into main — that's why the Deploy tab is hidden in here).
 *
 * It carries THREE ways out, and the first one is not an ending. An experiment
 * is somewhere you step in and out of, not only something you finish or throw
 * away: "Back to my copy" leaves it running, untouched, and it is waiting under
 * Advanced → Experiments when you want it again. Only merging and discarding
 * END it. The banner had just those two, so a user who wanted to go look at
 * their own copy for a minute had no move that did not destroy or conclude
 * their experiment — reported as exactly that.
 *
 * It NAMES THE PROCESS, because that is what an experiment is scoped to: an
 * experiment is not a second copy of the workspace, and the banner saying only
 * its title left the scope invisible.
 */
export function ExperimentBanner({
  copy,
  bpLabel,
  onLeave,
  onMergeBack,
  onDiscard,
  merging,
  refreshKey,
}: ExperimentBannerProps) {
  // "Is there anything to merge" is asked of the PARENT, live, on demand — the
  // `copies` SSE snapshot carries no divergence at all (it used to, at the cost
  // of a git fetch per copy × business process on every git event), and /status
  // is the wrong baseline anyway (it measures the copy against MAIN: an
  // experiment inherits its parent's whole divergence from main, so that signal
  // never goes quiet and the button stayed lit on an already-merged experiment
  // — every press came back noop).
  const { preview, error, refresh } = useMergePreview(copy.name);
  // An editor save is the event that changes dirtiness — refetch on it.
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) void refresh();
  }, [refreshKey, refresh]);
  // The rebase hint comes from the live preview and nowhere else. Until it
  // resolves — or when it failed — this line renders NOTHING: a stale or
  // invented "your copy has moved on" is worse than no hint, and a failed read
  // already has its own line further down.
  const parentMovedOn = !!preview && preview.behind > 0;
  // Nothing to merge: no commits the parent lacks, no uncommitted edits the
  // merge would commit for you, no business process born in here. Until the
  // preview resolves (or when it failed) the button stays available — the
  // merge itself is the authority, and a no-op merge ends the experiment
  // cleanly rather than stranding you in it.
  const nothingToMerge =
    !!preview &&
    preview.ahead === 0 &&
    preview.uncommitted.length === 0 &&
    preview.new_bps.length === 0;

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-emerald-300 bg-emerald-50 px-6 py-2 text-[13px] text-emerald-900">
      <FlaskConical className="mt-1 size-4 shrink-0 text-emerald-700" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {bpLabel
            ? `You are in an experiment on ${bpLabel}: ${copy.title ?? copy.name}`
            : `You are in an experiment: ${copy.title ?? copy.name}`}
        </div>
        <div className="text-[12px] text-emerald-800/80">
          {/* An experiment from before experiments were per-business-process.
              Which one it is on was never recorded and is not guessed — say
              that, so the missing process name reads as history rather than as
              a bug. */}
          {copy.bp_legacy && (
            <span>
              {`This experiment was started before experiments belonged to one business process, so which one it is on isn't recorded. Merge back what you want to keep and discard it. `}
            </span>
          )}
          {parentMovedOn && (
            <span>
              {`Your copy has moved on since this experiment started — merging may need a rebase. `}
            </span>
          )}
          {/* Secrets are per (business process, stage), never per copy: an
              experiment's live-dev reads the same dev secrets as everything
              else in the workspace. */}
          <span>Development secrets are shared across the whole workspace.</span>
          {/* The merge check couldn't be read — say so rather than quietly
              guessing whether there is anything to merge. */}
          {error && (
            <span className="text-red-700">
              {` Couldn't check what this experiment has to merge: ${error}`}
            </span>
          )}
        </div>
      </div>
      {/* The non-destructive exit, first and quiet: it is navigation, not an
          outcome, so it must not sit in the same visual class as the two
          buttons that end the experiment — and it says, in its tooltip, both
          that the experiment survives and where to find it again. */}
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-emerald-400 bg-white text-emerald-900 hover:bg-emerald-100"
        title="Leaves this experiment running — reopen it under Advanced → Experiments"
        onClick={onLeave}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to my copy
      </Button>
      <span
        className="shrink-0"
        title={
          nothingToMerge
            ? 'Nothing to merge yet — this experiment has no changes your copy lacks.'
            : 'Merge this experiment back into your own copy'
        }
      >
        <Button
          size="sm"
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          disabled={nothingToMerge || merging}
          onClick={onMergeBack}
        >
          <GitMerge className="size-3.5" aria-hidden />
          {merging ? 'Merging…' : 'Merge back into my copy'}
        </Button>
      </span>
      <Button
        size="sm"
        variant="destructive"
        className="shrink-0"
        disabled={merging}
        onClick={onDiscard}
      >
        <Trash2 className="size-3.5" aria-hidden />
        Discard experiment
      </Button>
    </div>
  );
}
