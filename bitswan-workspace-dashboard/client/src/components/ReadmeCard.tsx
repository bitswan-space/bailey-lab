import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card } from '@/components/ui/card';
import { useReadme } from '@/hooks/useReadme';

interface ReadmeCardProps {
  bpId: string;
}

export function ReadmeCard({ bpId }: ReadmeCardProps) {
  const { content, loading } = useReadme(bpId);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Specification
        </div>
        <div className="text-lg font-semibold tracking-tight text-foreground">README</div>
      </div>
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
