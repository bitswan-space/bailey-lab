import { Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopyIdentity } from '@/lib/identity';
import type { Copy } from '@/types';

export interface ViewingBannerProps {
  /** The copy in view — someone else's copy, or one of their experiments. */
  copy: Copy;
  /** Switch back to the signed-in user's own copy. Omitted while their own
   *  copy hasn't resolved yet — there'd be nowhere to switch back to. */
  onSwitchBack?: () => void;
}

/**
 * Awareness banner for working in someone else's copy: it says whose copy
 * you're in and offers one click back to your own. It does NOT gate anything
 * — you can change a colleague's copy exactly as you can your own — so the
 * banner names the copy your edits are landing in. It deliberately does not
 * say "viewing": that would promise read-only, and the write that follows
 * would be the very mistake this banner exists to prevent.
 */
export function ViewingBanner({ copy, onSwitchBack }: ViewingBannerProps) {
  const isExperiment = copy.kind === 'experiment';
  // Only USER copy slugs are resolvable in the AOC directory — it
  // forward-matches slugs against real people, so an experiment's opaque slug
  // would be misread as a person. An experiment's owner is resolved through
  // its parent copy instead.
  const ownerSlug = isExperiment ? copy.parent : copy.name;
  const identity = useCopyIdentity(ownerSlug);
  // A legacy copy resolves to nobody: name it by its raw slug rather than
  // inventing an owner.
  const who = identity?.name || identity?.email || ownerSlug || copy.name;
  const what = isExperiment
    ? `${who}'s experiment "${copy.title ?? copy.name}"`
    : `${who}'s copy`;
  // Name where the edits land, not just where you are: nothing is gated here,
  // so the banner must not imply otherwise.
  const where = isExperiment ? 'experiment' : 'copy';

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-[13px] text-amber-900">
      <Eye className="size-4 shrink-0 text-amber-700" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{`You are in ${what} — your edits save to their ${where}`}</span>
      {onSwitchBack && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
          onClick={onSwitchBack}
        >
          Switch back to my copy
        </Button>
      )}
    </div>
  );
}
