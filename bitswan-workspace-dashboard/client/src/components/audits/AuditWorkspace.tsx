import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { api, errorMessage, type AuditState } from '@/lib/api';
import { toast } from '@/lib/notify';

export interface AuditWorkspaceProps {
  bp: string;
  /** Enter the audit copy — the same copy switch the rest of the app uses. */
  onEnterCopy: (copy: string, message: string) => void;
}

/**
 * The way into an audit: one button.
 *
 * An audit is done in a copy of the version under audit, and everything an
 * auditor needs is already in there — the agent, the file explorer, the diff,
 * the report, and the sign-off on its own tab. So this is a door, not a
 * description of the room behind it.
 */
export function AuditWorkspace({ bp, onEnterCopy }: AuditWorkspaceProps) {
  const [state, setState] = useState<AuditState | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.audits.state(bp));
    } catch {
      // The button falls back to its neutral label; the Audits section around
      // it already says whether staging is frozen.
    }
  }, [bp]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async () => {
    setOpening(true);
    const work = api.audits.open(bp);
    toast.promise(work, {
      loading: 'Opening the code for auditing…',
      success: 'You are in the audit copy',
      error: (e: unknown) => `Couldn’t open the audit: ${errorMessage(e)}`,
    });
    try {
      const opened = await work;
      onEnterCopy(opened.name, 'Opening the code for auditing…');
    } catch {
      /* toast handled */
    } finally {
      setOpening(false);
    }
  };

  const changed = state?.proposed_changes?.length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void open()}
        disabled={opening}
        className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-background px-3 text-[12px] font-medium hover:bg-muted disabled:opacity-50"
      >
        {opening ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <FolderOpen className="size-3.5" aria-hidden />
        )}
        Open the code for auditing
      </button>
      {changed > 0 && (
        <span className="text-[11px] text-violet-800">
          {changed} changed file{changed === 1 ? '' : 's'} in your audit copy — deploying them
          proposes a new version.
        </span>
      )}
    </div>
  );
}
