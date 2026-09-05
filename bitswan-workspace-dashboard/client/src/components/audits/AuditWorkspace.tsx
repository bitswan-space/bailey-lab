import { useCallback, useEffect, useState } from 'react';
import { FileText, Gavel, Loader2, Rocket } from 'lucide-react';
import { api, errorMessage, type AuditState } from '@/lib/api';
import { toast } from '@/lib/notify';

export interface AuditWorkspaceProps {
  bp: string;
  canAudit: boolean;
  /** Enter the audit copy — the same copy switch the rest of the app uses. */
  onEnterCopy: (copy: string, message: string) => void;
}

/**
 * The audit, as an entry point rather than an environment of its own.
 *
 * An auditor works in a COPY of the version under audit: the agent, the file
 * explorer, the diff and Deploy are the ones they already know, and the report
 * is a file in the business process. So this panel opens that copy and states
 * the two exits — sign the frozen version off, or change it and propose the
 * result as a new version.
 */
export function AuditWorkspace({ bp, canAudit, onEnterCopy }: AuditWorkspaceProps) {
  const [state, setState] = useState<AuditState | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.audits.state(bp));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [bp]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async () => {
    setOpening(true);
    const work = api.audits.open(bp);
    toast.promise(work, {
      loading: 'Opening the audit…',
      success: 'The audit copy is ready',
      error: (e: unknown) => `Couldn’t open the audit: ${errorMessage(e)}`,
    });
    try {
      const opened = await work;
      onEnterCopy(opened.name, 'Entering the audit…');
    } catch {
      /* toast handled */
    } finally {
      setOpening(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-[12px] text-muted-foreground">
        Couldn’t read the audit: {error}
      </div>
    );
  }
  if (!state) {
    return <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">Loading…</div>;
  }
  if (!state.frozen) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-[12px] text-muted-foreground">
        {state.reason ?? 'Staging is not frozen, so there is no version under audit.'}
      </div>
    );
  }

  const proposed = state.proposed_changes?.length ?? 0;
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3">
      <div className="flex items-start gap-2">
        <Gavel className="mt-0.5 size-4 shrink-0 text-violet-600" aria-hidden />
        <div className="min-w-0 flex-1 text-[12px]">
          <div className="font-medium">
            {state.exists ? 'Your audit of this image is open' : 'Audit this image in a copy'}
          </div>
          <p className="mt-1 text-muted-foreground">
            The audit happens in a copy holding the version this image was built from
            {state.audited_commit ? (
              <>
                {' '}
                (<code className="font-mono">{state.audited_commit.slice(0, 8)}</code>)
              </>
            ) : null}
            . Read it with the agent, the file explorer and the diff you already use, and write
            your findings to <code className="font-mono">{state.report_path}</code>.
          </p>
          <p className="mt-1 text-muted-foreground">
            Nothing you do there changes what is frozen. If you find something and fix it,
            deploying the fix starts a <strong>new version</strong> in Development, which needs
            its own sign-off — that is the alternative to signing this one off, not a shortcut
            through it.
          </p>
          {proposed > 0 && (
            <p className="mt-1 flex items-center gap-1.5 text-violet-800">
              <Rocket className="size-3.5" aria-hidden />
              You have changed {proposed} file{proposed === 1 ? '' : 's'} in the audit copy — a
              proposal waiting to be deployed.
            </p>
          )}
        </div>
        {canAudit && (
          <button
            type="button"
            onClick={() => void open()}
            disabled={opening}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            {opening ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {state.exists ? 'Continue the audit' : 'Open the audit'}
            {!canAudit && <FileText className="size-3.5" aria-hidden />}
          </button>
        )}
      </div>
    </div>
  );
}
