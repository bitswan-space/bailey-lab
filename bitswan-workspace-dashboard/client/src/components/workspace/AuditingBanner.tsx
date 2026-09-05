import { Gavel, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Copy } from '@/types';

export interface AuditingBannerProps {
  /** The audit copy in view. */
  copy: Copy;
  /** The business process's display name. */
  bpLabel: string;
  /** Files the auditor has changed here — a proposal, not a sign-off. */
  proposedChanges: number;
  /** Back to the auditor's own copy. */
  onLeave: () => void;
  /** To the Audits section, where the sign-off lives. */
  onGoToAudits: () => void;
  /** To the Deploy screen, which is how a proposal becomes a new version. */
  onGoToDeploy: () => void;
}

/**
 * You are auditing.
 *
 * This is a copy like any other — the agent, the file explorer, the diff and
 * Deploy all work — holding the exact version the frozen staging image was
 * built from. Two things follow, and the banner says both:
 *
 * - Nothing here changes what is frozen. The sign-off attaches to the image's
 *   content hash, and that image is not this copy.
 * - Changing something is not an alternative way to approve it: it is a
 *   proposal. Deploying goes to Development and becomes a new version, which
 *   needs its own sign-off like anything else.
 */
export function AuditingBanner({
  copy,
  bpLabel,
  proposedChanges,
  onLeave,
  onGoToAudits,
  onGoToDeploy,
}: AuditingBannerProps) {
  const sha = (copy.audited?.sha ?? '').slice(0, 8);
  const proposing = proposedChanges > 0;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-violet-300 bg-violet-50 px-6 py-2 text-[13px] text-violet-900">
      <Gavel className="size-4 shrink-0 text-violet-700" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          You are auditing {bpLabel || copy.bp}
          {sha ? ` · image ${sha}` : ''}
        </span>
        <span className="ml-2 text-violet-800">
          {proposing
            ? `You have changed ${proposedChanges} file${proposedChanges === 1 ? '' : 's'} — that is a proposal, not a sign-off. Deploying it starts a new version in Development, with its own audit.`
            : 'This copy holds the frozen version. Reading and editing it here changes nothing that is deployed.'}
        </span>
      </span>
      {proposing && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-violet-400 bg-white text-violet-900 hover:bg-violet-100"
          onClick={onGoToDeploy}
        >
          <Rocket className="mr-1 size-3.5" aria-hidden /> Propose as a new version
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-violet-400 bg-white text-violet-900 hover:bg-violet-100"
        onClick={onGoToAudits}
      >
        Sign off
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-violet-400 bg-white text-violet-900 hover:bg-violet-100"
        onClick={onLeave}
      >
        Leave the audit
      </Button>
    </div>
  );
}
