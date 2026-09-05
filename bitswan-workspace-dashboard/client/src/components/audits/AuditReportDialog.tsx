import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MermaidPreview, PreviewErrorBoundary } from '@/components/workspace/spec-node-views';
import { RelativeTime } from '@/components/shared/RelativeTime';
import { cn } from '@/lib/utils';

function fenceLanguage(className: string | undefined): string {
  return /language-([\w-]+)/.exec(className ?? '')?.[1] ?? '';
}

/**
 * A stored audit report, rendered the way it was written.
 *
 * The report is markdown from the same editor the description uses, so reading
 * it back as plain text loses exactly what the auditor put there to be read:
 * the headings, the tables, and the diagrams. Fenced mermaid goes through the
 * editor's own diagram renderer, so the report and the report-as-recorded are
 * the same document.
 */
export function AuditReportBody({ report }: { report: string }) {
  return (
    <div className="audit-report prose prose-sm prose-zinc max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const fence: ReactNode = Array.isArray(children) ? children[0] : children;
            if (isValidElement<{ className?: string; children?: ReactNode }>(fence)) {
              if (fenceLanguage(fence.props.className) === 'mermaid') {
                const source = String(fence.props.children ?? '');
                return (
                  <div className="mermaid-preview-static not-prose">
                    <div className="mermaid-preview-rf">
                      <PreviewErrorBoundary resetKey={source} hint="">
                        <MermaidPreview source={source} hint="" />
                      </PreviewErrorBoundary>
                    </div>
                  </div>
                );
              }
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {report}
      </ReactMarkdown>
    </div>
  );
}

export interface AuditReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  who: string;
  at?: string;
  verdict?: 'approve' | 'reject';
  report?: string | null;
  note?: string | null;
}

/** The report behind one verdict, opened from wherever that verdict is shown. */
export function AuditReportDialog({
  open,
  onOpenChange,
  who,
  at,
  verdict,
  report,
  note,
}: AuditReportDialogProps) {
  const body = (report ?? '').trim();
  const approved = verdict !== 'reject';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(92vw,900px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-6 py-4 text-left">
          <DialogTitle className="text-[15px]">Audit report</DialogTitle>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">{who}</span>
            {verdict && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  approved ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
                )}
              >
                {approved ? (
                  <Check className="size-3" aria-hidden />
                ) : (
                  <X className="size-3" aria-hidden />
                )}
                {approved ? 'Approved' : 'Changes requested'}
              </span>
            )}
            {at && (
              <span>
                {'· '}
                <RelativeTime value={at} />
              </span>
            )}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {body ? (
            <AuditReportBody report={body} />
          ) : note ? (
            <div className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
              {note}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">
              No report was recorded with this verdict.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
