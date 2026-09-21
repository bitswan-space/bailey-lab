import { STALE_TONE, VERDICT_TONES, type DisplayVerdict } from '@/lib/testStatus';

interface Props {
  verdict: DisplayVerdict;
  /**
   * True when this verdict belongs to an earlier commit than the code on disk.
   * Rendered muted rather than hidden: knowing what was true last time is
   * useful, as long as nothing pretends it is true now.
   */
  stale?: boolean;
}

/**
 * Pill badge for a requirement's verdict. Colours come from the shared tone
 * map, which the nav indicator and the tab summary read too.
 *
 * DISPLAY ONLY, and now structurally so: a verdict is produced by running a
 * test and there is no longer any code path — UI, API or file — by which a
 * person can assert one. This badge reports; it never offers.
 */
export function StatusBadge({ verdict, stale = false }: Props) {
  const tone = VERDICT_TONES[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        stale ? STALE_TONE.badge : tone.badge
      }`}
      title={stale ? 'From the previous commit — the code has changed since' : undefined}
    >
      {tone.label}
    </span>
  );
}
