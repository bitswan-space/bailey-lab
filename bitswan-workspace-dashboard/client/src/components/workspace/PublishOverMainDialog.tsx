import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage, type DeployOverMainPreview } from '@/lib/api';
import {
  describeSuperseded,
  publishConfirmed,
  PUBLISH_MODE_SUMMARY,
  type PublishMode,
} from '@/lib/publishOverMain';

export interface PublishOverMainDialogProps {
  open: boolean;
  /** The copy being published — the caller's own. */
  copy: string;
  /** The business process's directory slug (what gets typed to confirm). */
  bp: string;
  /** …and its display name, for everything a person reads. */
  bpLabel: string;
  busy: boolean;
  /** Publish. `expectedMain` is the tip this dialog described, so a main that
   *  moved in the meantime is refused rather than silently gone over. */
  onConfirm: (mode: PublishMode, expectedMain: string) => void;
  onCancel: () => void;
}

/**
 * The second way out of a blocked Deploy: publish your version even though
 * main has moved on.
 *
 * The whole dialog exists to make one thing impossible — pressing this without
 * knowing WHOSE work it goes over. The commits main has and your copy does not
 * are read live and listed by subject and author, because they are colleagues'
 * commits and a summary like "main has diverged" hides exactly the fact that
 * would change the decision. A failed read is not smoothed over: the dialog
 * says it could not find out and refuses to enable the button, since the only
 * alternative is to understate the damage.
 */
export function PublishOverMainDialog({
  open,
  copy,
  bp,
  bpLabel,
  busy,
  onConfirm,
  onCancel,
}: PublishOverMainDialogProps) {
  // eslint-disable-next-line no-restricted-syntax -- null = not read yet
  const [preview, setPreview] = useState<DeployOverMainPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<PublishMode>('rebase');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError('');
    setMode('rebase');
    setTyped('');
    setLoading(true);
    let alive = true;
    api.copyFiles
      .deployOverMainPreview(copy, bp)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, copy, bp]);

  const ready = !!preview && !busy;
  const confirmEnabled = ready && publishConfirmed(typed, bp);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish your version of {bpLabel} over main?</DialogTitle>
          <DialogDescription>
            Main has changes your copy does not. Syncing replays your work on
            top of them; this does the opposite — it publishes yours and takes
            the decision away from whoever made those changes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-[13px] leading-snug">
          {loading && <div className="text-muted-foreground">Reading main…</div>}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Couldn't read what this would go over: {error}. Nothing will be
                published until that can be answered.
              </span>
            </div>
          )}
          {preview && (
            <>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                This supersedes {describeSuperseded(preview.superseded)}.
              </div>
              <div className="max-h-52 overflow-auto rounded-md border">
                <table className="w-full text-left text-[12px]">
                  <tbody>
                    {preview.superseded.map((c) => (
                      <tr key={c.sha} className="border-b last:border-0">
                        <td className="w-20 px-2 py-1 font-mono text-muted-foreground">
                          {c.sha.slice(0, 7)}
                        </td>
                        <td className="px-2 py-1">{c.subject}</td>
                        <td className="w-48 px-2 py-1 text-muted-foreground">
                          {c.author_name || c.author}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">What happens to them</legend>
                {(['rebase', 'exact'] as PublishMode[]).map((m) => (
                  <label
                    key={m}
                    className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 has-[:checked]:border-foreground"
                  >
                    <input
                      type="radio"
                      name="publish-mode"
                      className="mt-1"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    <span>
                      <span className="font-medium">
                        {m === 'rebase'
                          ? 'Your version wins the overlaps (recommended)'
                          : 'Make main exactly my version'}
                      </span>
                      <br />
                      <span className="text-muted-foreground">
                        {PUBLISH_MODE_SUMMARY[m]}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <p className="text-muted-foreground">
                Your commits are kept as they are — each one arrives on main as
                itself, and main's own commits stay in the history underneath.
                If a change cannot be resolved automatically (one side deleted a
                file the other edited), nothing is published and the coding
                agent takes over.
              </p>

              <label className="flex flex-col gap-1">
                <span>
                  Type <span className="font-mono font-medium">{bp}</span> to
                  confirm.
                </span>
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={bp}
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmEnabled}
            onClick={() => preview && onConfirm(mode, preview.main)}
          >
            {busy ? 'Publishing…' : 'Publish over main'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
