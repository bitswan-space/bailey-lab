import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card } from '@/components/ui/card';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { useReadme } from '@/hooks/useReadme';

interface ReadmeCardProps {
  bpId: string;
  /** When set, read the worktree's copy of the README instead of main's. */
  worktree?: string;
}

export function ReadmeCard({ bpId, worktree }: ReadmeCardProps) {
  const { content, loading } = useReadme(bpId, worktree);

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader eyebrow="Specification" title="README" />
      <Card className="px-6 py-5">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : content ? (
          <div className="prose prose-sm prose-zinc max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No README yet.</div>
        )}
      </Card>
    </section>
  );
}
