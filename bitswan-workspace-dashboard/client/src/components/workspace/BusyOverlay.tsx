import { Loader2 } from 'lucide-react';

export interface BusyOverlayProps {
  /** What the user is waiting for, in their words: "Starting experiment on
   *  Compost…", "Switching to Kamil Kolega's copy…". Present tense, named. */
  label: string;
}

/**
 * The app, locked, while a copy transition settles.
 *
 * Moving between copies is not one state change: the request has to land, the
 * copies feed has to deliver the destination, and only then can the top bar and
 * the banner agree about where you are. Rendered as it happens, that is a
 * sequence of half-states — a green experiment banner over a pipeline that
 * still has the parent copy's Deploy step in it, or the reverse. Every one of
 * them is wrong, and the user cannot tell a half-state from a finished one.
 *
 * So the app is LOCKED instead: a grey sheet over everything, naming what is
 * happening, from the frame of the click until the destination is fully
 * renderable. Nothing underneath is clickable or focusable while it is up, and
 * when it lifts the whole interface is correct at once.
 *
 * It is never dismissed by giving up quietly: a failed transition drops it and
 * surfaces the real error, and a transition that never arrives drops it and
 * says so (see `Busy` in App).
 */
export function BusyOverlay({ label }: BusyOverlayProps) {
  return (
    <div
      // role=status + aria-busy so a screen reader announces the wait rather
      // than the user meeting an app that has silently stopped responding.
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="busy-overlay"
      // `inert`-like containment without the polyfill: the sheet covers the
      // viewport and swallows pointer events, and nothing inside it is
      // focusable, so a keyboard user cannot tab into the frozen app either.
      className="fixed inset-0 z-[100] flex items-center justify-center bg-neutral-900/35 backdrop-blur-[1px]"
      onKeyDownCapture={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-5 py-3.5 shadow-lg">
        <Loader2
          // Respect prefers-reduced-motion: the label already says what is
          // happening, so the spin is decoration and is dropped rather than
          // being the only signal.
          className="size-4 shrink-0 text-primary motion-safe:animate-spin"
          aria-hidden
        />
        <span className="text-[13px] font-medium text-foreground">{label}</span>
      </div>
    </div>
  );
}
