import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  Play,
  Plus,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { toast } from '@/lib/notify';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useRequirements } from '@/hooks/useRequirements';
import { useBpTestState } from '@/components/workspace/WorkspaceProvider';
import { RequirementsTable } from './RequirementsTable';
import { TreegridLegend } from './TreegridLegend';
import { useUrlParam } from '@/lib/urlState';
import { cn } from '@/lib/utils';
import { api, type Requirement, type RequirementTestResult } from '@/lib/api';

interface Props {
  copy: string;
  bp: string;
  /** Caller-controlled handler to flip the workspace to the Coding Agent tab. */
  onShowAgents: () => void;
}

/**
 * Per-(copy, bp) requirements view.
 *
 * Two sources, deliberately separate: the CONTRACT (what the requirements are)
 * comes from `testable-requirements.toml` via `useRequirements`, and the
 * VERDICTS come from gitops over SSE via `useBpTestState`. Nothing in this tab
 * can set a verdict — tests run on every commit and their reports are the only
 * thing that produces one.
 *
 * Rows are grouped by verdict rather than filtered by it: what a person opens
 * this tab to see is what is broken, and a filter makes that a click away
 * instead of the first thing on screen.
 */
export function RequirementsTab({ copy, bp, onShowAgents }: Props) {
  const { requirements, loading, add, update, remove, runTests } = useRequirements(
    copy,
    bp,
  );
  const testState = useBpTestState(bp);

  const [searchRaw, setSearchRaw] = useUrlParam('q');
  const search = searchRaw ?? '';
  const setSearch = useCallback(
    (v: string) => setSearchRaw(v || null),
    [setSearchRaw],
  );
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Requirement | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [starting, setStarting] = useState(false);

  const results = useMemo(() => {
    const map = new Map<string, RequirementTestResult>();
    for (const r of testState?.requirements ?? []) map.set(r.id, r);
    return map;
  }, [testState]);

  const stale = testState?.stale ?? false;
  const runInFlight = testState?.status === 'running';

  const matches = useCallback(
    (r: Requirement) => {
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return (
        r.id.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term)
      );
    },
    [search],
  );

  /**
   * Requirements split into the groups the tab renders, in the order a person
   * needs them: what is broken, what is still being checked, what has no test,
   * what passed, and what the agent has proposed.
   */
  const groups = useMemo(() => {
    const visible = requirements.filter(matches);
    const verdictOf = (r: Requirement) => results.get(r.id)?.verdict;
    const proposed = visible.filter((r) => r.origin === 'proposed');
    const rest = visible.filter((r) => r.origin !== 'proposed');
    return {
      failed: rest.filter((r) => verdictOf(r) === 'fail'),
      blocked: rest.filter((r) => verdictOf(r) === 'blocked'),
      running: rest.filter(
        (r) => verdictOf(r) === 'running' || verdictOf(r) === 'queued',
      ),
      noTest: rest.filter((r) => verdictOf(r) === 'no_test' || !verdictOf(r)),
      passed: rest.filter((r) => verdictOf(r) === 'pass'),
      proposed,
    };
  }, [requirements, results, matches]);

  const counts = testState?.counts;

  const onNew = async (parent?: Requirement) => {
    try {
      const created = await add('', parent?.id);
      setPendingEditId(created.id);
    } catch (err) {
      toast.error(`Failed to add requirement: ${String(err)}`);
    }
  };

  const onAcceptProposal = async (r: Requirement) => {
    try {
      await update(r.id, { accept: true });
    } catch (err) {
      toast.error(`Failed to accept the proposal: ${String(err)}`);
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

  /**
   * Starting a run only starts it: gitops runs the tests in the background and
   * the verdicts arrive over SSE, so there is nothing to await here beyond the
   * hand-off. Tests also start on their own with every commit — these buttons
   * are for re-running without one.
   */
  const startRun = async (opts: { id?: string; failedOnly?: boolean } = {}) => {
    if (starting || runInFlight) return;
    setStarting(true);
    try {
      await runTests(opts);
    } catch (err) {
      toast.error(`Failed to start the tests: ${String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  // "Write tests" gives the agent the job, then shows it. The prompt lands in
  // the panel's composer for the user to send. Navigating is not conditional
  // on the hand-off: a panel with an empty box is recoverable, being left on
  // this tab wondering what happened is not.
  const onStartCanned = (kind: 'write-tests' | 'automation') => {
    api.codingAgent.handOffTask(copy, bp, kind).catch((err: unknown) => {
      toast.error(`Could not hand the task to the agent: ${String(err)}`);
    });
    onShowAgents();
  };

  const tableProps = {
    results,
    stale,
    loading,
    pendingEditId,
    onEditDone: () => setPendingEditId(null),
    onAcceptProposal: (r: Requirement) => void onAcceptProposal(r),
    onUpdateDescription: (r: Requirement, text: string) =>
      void onUpdateDescription(r, text),
    onAddChild: (parent: Requirement) => void onNew(parent),
    onDelete: (r: Requirement) => setDeleteTarget(r),
    onRunTest: (r: Requirement) => void startRun({ id: r.id }),
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden bg-background">
        {/* Summary: the state of the suite for the commit it ran against. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-2.5">
          {counts ? (
            <div className="flex items-center gap-3 text-[12px]">
              <Stat n={counts.fail + counts.blocked} label="failing" tone="text-red-700" />
              <Stat
                n={counts.running + counts.queued}
                label="running"
                tone="text-blue-700"
              />
              <Stat n={counts.pass} label="passing" tone="text-green-700" />
              {counts.no_test > 0 && (
                <Stat n={counts.no_test} label="without a test" tone="text-slate-600" />
              )}
            </div>
          ) : (
            <span className="text-[12px] text-muted-foreground">
              {loading ? 'Loading…' : 'No test run yet — tests run on every commit.'}
            </span>
          )}
          {testState && (
            <span className="truncate text-[11px] text-muted-foreground">
              {testState.head_subject || 'no commit message'}{' '}
              <span className="font-mono">{testState.head_sha.slice(0, 7)}</span>
            </span>
          )}
          {stale && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              out of date — the code changed since
            </span>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-3">
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

          <div className="ml-auto flex items-center gap-2">
            <Button onClick={() => void onNew()} size="sm" variant="outline">
              <Plus className="size-3.5" aria-hidden />
              New requirement
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    onClick={() => void startRun({ failedOnly: true })}
                    size="sm"
                    variant="outline"
                    disabled={starting || runInFlight || !counts?.fail}
                  >
                    <RotateCw className="size-3.5" aria-hidden />
                    Re-run failed
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Re-run only the requirements that failed, against the current code
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    onClick={() => void startRun()}
                    size="sm"
                    variant="outline"
                    disabled={starting || runInFlight}
                  >
                    {starting || runInFlight ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Play className="size-3.5" aria-hidden />
                    )}
                    Run tests
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Tests run automatically on every commit — this re-runs them all now
              </TooltipContent>
            </Tooltip>
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

        <div className="flex-1 space-y-4 overflow-auto px-6 py-4">
          {testState?.error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              The last test run could not complete: {testState.error}
            </div>
          )}

          <Group
            title="Failing"
            n={groups.failed.length}
            tone="text-red-700"
            hidden={groups.failed.length === 0}
          >
            <RequirementsTable {...tableProps} requirements={groups.failed} />
          </Group>

          <Group
            title="Blocked"
            n={groups.blocked.length}
            tone="text-amber-700"
            hidden={groups.blocked.length === 0}
            note="Not run — a parent requirement is failing. Fix the parent first."
          >
            <RequirementsTable {...tableProps} requirements={groups.blocked} />
          </Group>

          <Group
            title="Running"
            n={groups.running.length}
            tone="text-blue-700"
            hidden={groups.running.length === 0}
          >
            <RequirementsTable {...tableProps} requirements={groups.running} />
          </Group>

          <Group
            title="No test yet"
            n={groups.noTest.length}
            tone="text-slate-600"
            hidden={groups.noTest.length === 0}
            note="No test carries these ids. They do not block a deploy, but nothing verifies them either."
          >
            <RequirementsTable {...tableProps} requirements={groups.noTest} />
          </Group>

          <Group
            title="Passing"
            n={groups.passed.length}
            tone="text-green-700"
            hidden={groups.passed.length === 0}
            collapsible
            open={showPassed}
            onToggle={() => setShowPassed((v) => !v)}
          >
            <RequirementsTable {...tableProps} requirements={groups.passed} />
          </Group>

          <Group
            title="Proposed by the agent"
            n={groups.proposed.length}
            tone="text-violet-700"
            hidden={groups.proposed.length === 0}
            note="Accept one to add it to the contract, or delete it."
          >
            <RequirementsTable {...tableProps} requirements={groups.proposed} />
          </Group>

          {requirements.length === 0 && (
            <RequirementsTable
              {...tableProps}
              requirements={[]}
              onAddRoot={() => void onNew()}
              emptyText="No requirements yet. Add one to describe what this automation must do."
            />
          )}
        </div>

        {/* Outside the scroller above, so the key map is pinned to the bottom
            of the tab and cannot scroll out of sight on a long list. */}
        <TreegridLegend />

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
                This requirement will be deleted. Its sub-requirements are kept
                and will move to the top level of the list.
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
    </TooltipProvider>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn('text-[13px] font-bold', n > 0 ? tone : 'text-muted-foreground')}>
        {n}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function Group({
  title,
  n,
  tone,
  hidden,
  note,
  collapsible = false,
  open = true,
  onToggle,
  children,
}: {
  title: string;
  n: number;
  tone: string;
  hidden: boolean;
  note?: string;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  if (hidden) return null;
  const header = (
    <div className="flex items-center gap-2">
      {collapsible &&
        (open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
        ))}
      <span className={cn('text-[12px] font-semibold uppercase tracking-wide', tone)}>
        {title}
      </span>
      <span className="text-[11px] font-semibold text-muted-foreground">{n}</span>
    </div>
  );
  return (
    <section>
      <div className="mb-1.5">
        {collapsible ? (
          <button type="button" onClick={onToggle} className="w-full text-left">
            {header}
          </button>
        ) : (
          header
        )}
        {note && open && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>
        )}
      </div>
      {open && children}
    </section>
  );
}
