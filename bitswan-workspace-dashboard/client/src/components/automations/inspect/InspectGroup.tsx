import { cn } from '@/lib/utils';
import type { Row } from './docker-inspect-rows';

interface InspectGroupProps {
  heading: string;
  rows: Row[];
  fullSpan?: boolean;
}

export function InspectGroup({ heading, rows, fullSpan }: InspectGroupProps) {
  if (rows.length === 0) return null;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border bg-background',
        fullSpan && 'md:col-span-2',
      )}
    >
      <div className="border-b border-border bg-muted/40 px-3.5 py-2 text-xs font-semibold uppercase tracking-wide text-foreground">
        {heading}
      </div>
      <table className="w-full table-fixed border-collapse text-xs">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={k} className={cn(i > 0 && 'border-t border-border')}>
              <td className="w-2/5 px-3.5 py-2 align-top text-muted-foreground">{k}</td>
              <td className="break-all px-3.5 py-2 align-top text-foreground">{v ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
