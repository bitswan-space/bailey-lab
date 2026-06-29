import { useCallback, useMemo, useState } from 'react';
import { FlaskConical, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useRequirements } from '@/hooks/useRequirements';
import { useSessions, type BpSessionKind } from '@/components/agents/SessionProvider';
import { nextStatus } from './StatusBadge';
import { RequirementsTable } from './RequirementsTable';
import { useUrlEnum, useUrlParam } from '@/lib/urlState';
import { cn } from '@/lib/utils';
import type { Requirement, ReqStatus } from '@/lib/api';

interface Props {
  copy: string;
  bp: string;
  /** Caller-controlled handler to flip the workspace to the Coding Agent tab. */
  onShowAgents: () => void;
}

type Filter = 'all' | ReqStatus;

const FILTERS: Filter[] = ['all', 'pending', 'pass', 'fail', 'retest', 'proposed'];

// Per-filter colour for the count digit shown in an inactive pill (matches
// the status-badge tones; the active pill inverts to its own foreground).
const COUNT_COLOR: Record<Filter, string> = {
  all: 'text-muted-foreground',
  pending: 'text-slate-600',
  pass: 'text-green-700',
  fail: 'text-red-700',
  retest: 'text-amber-700',
  proposed: 'text-violet-700',
};

/**
 * Per-(copy, bp) testable requirements view. Reads/writes the same
 * `testable-requirements.toml` the agent CLI uses, so flipping a status
 * here is visible from `bitswan-coding-agent requirements list` and
 * vice-versa.
 */
export function RequirementsTab({ copy, bp, onShowAgents }: Props) {
  const {
    requirements,
    loading,
    add,
    update,
    remove,
  } = useRequirements(copy, bp);
  const {
    startSession,
    startRequirementSession,
    setSelectedFor,
    agentStatus,
    ensureAgent,
  } = useSessions();

  // Search term and status filter live in the URL so a filtered view is
  // deep-linkable (?filter=fail&q=auth).
  const [searchRaw, setSearchRaw] = useUrlParam('q');
  const search = searchRaw ?? '';
  const setSearch = useCallback(
    (v: string) => setSearchRaw(v || null),
    [setSearchRaw],
  );
  const [filter, setFilter] = useUrlEnum('filter', FILTERS, 'all');
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Requirement | null>(null);

  const counts = useMemo(() => {
    const c = { total: 0, pass: 0, fail: 0, pending: 0, retest: 0, proposed: 0 };
    for (const r of requirements) {
      c.total += 1;
      c[r.status] += 1;
    }
    return c;
  }, [requirements]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return requirements.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false;
      if (!term) return true;
      return (
        r.id.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term)
      );
    });
  }, [requirements, filter, search]);

  const onNew = async (parent?: Requirement) => {
    try {
      const created = await add({
        text: '',
        ...(parent ? { parent: parent.id } : {}),
      });
      setPendingEditId(created.id);
    } catch (err) {
      toast.error(`Failed to add requirement: ${String(err)}`);
    }
  };

  const onCycleStatus = async (r: Requirement) => {
    const target = nextStatus(r.status);
    try {
      await update(r.id, { status: target });
    } catch (err) {
      toast.error(`Failed to update status: ${String(err)}`);
    }
  };

  const onUpdateDescription = async (r: Requirement, text: string) => {
    try {
      await update(r.id, { description: text });
    } catch (err) {
      toast.error(`Failed to save description: ${String(err)}`);
    }
  };

  const onDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    try {
      await remove(id);
    } catch (err) {
      toast.error(`Failed to delete ${id}: ${String(err)}`);
    }
  };

  const onRunAgent = async (r: Requirement) => {
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // surfaces via agentStatus; the session will still attempt to spawn
      }
    }
    const id = startRequirementSession(copy, bp, r.id);
    setSelectedFor({ copy, bp }, id);
    onShowAgents();
  };

  // "Write tests" / "Build automation": same launch flow as onRunAgent but
  // against the whole requirements set — the server picks the canned prompt
  // from the kind.
  const onStartCanned = async (kind: BpSessionKind) => {
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // surfaces via agentStatus; the session will still attempt to spawn
      }
    }
    startSession(copy, bp, kind);
    onShowAgents();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-3">
        {/* Search */}
        <div className="flex h-8 w-full max-w-[380px] items-center gap-2 rounded-md border border-border bg-white px-2.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search requirements by id or description…"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>

        {/* Status filter pills with counts */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => {
            const active = filter === f;
            const n = f === 'all' ? counts.total : counts[f];
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium capitalize transition-colors',
                  active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-white text-muted-foreground hover:bg-muted/60',
                )}
              >
                {f}
                <span
                  className={cn(
                    'text-[10px] font-bold',
                    active ? 'text-background/80' : COUNT_COLOR[f],
                  )}
                >
                  {loading ? '·' : n}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            onClick={() => void onStartCanned('write-tests')}
            size="sm"
            variant="outline"
            title="Start an agent session that writes tests for these requirements"
          >
            <FlaskConical className="size-3.5" aria-hidden />
            Write tests
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <RequirementsTable
          requirements={visible}
          loading={loading}
          pendingEditId={pendingEditId}
          onEditDone={() => setPendingEditId(null)}
          onCycleStatus={onCycleStatus}
          onUpdateDescription={onUpdateDescription}
          onAddChild={(parent) => void onNew(parent)}
          onAddRoot={() => void onNew()}
          onDelete={(r) => setDeleteTarget(r)}
          onRunAgent={(r) => void onRunAgent(r)}
        />
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete requirement &quot;{deleteTarget?.id}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The requirement is removed from the TOML. Children of this
              requirement are kept but become orphans (rendered at the
              root) — same behaviour as{' '}
              <code>bitswan-coding-agent requirements remove</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void onDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
