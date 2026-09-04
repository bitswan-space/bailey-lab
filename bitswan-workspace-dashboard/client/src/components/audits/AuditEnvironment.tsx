import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  FileSearch,
  FileText,
  GitCompare,
  Loader2,
  MessageSquare,
  Save,
  Sparkles,
} from 'lucide-react';
import {
  api,
  errorMessage,
  type AuditEnv,
  type AuditSearchMatch,
  type ChangedKind,
  type FileTreeNode,
} from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { DiffView } from '@/components/diff/DiffView';
import { FileTree } from '@/components/files/FileTree';
import { AuditChat } from './AuditChat';

const CodeEditor = lazy(() => import('@/components/files/CodeEditor'));

// The audited source is a snapshot: no VCS status badges, nothing to drag in.
const EMPTY_STATUS: Map<string, ChangedKind> = new Map();
const NOOP = () => {};

type Panel = 'chat' | 'source' | 'diff' | 'report';

const PANELS: { id: Panel; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Agent', icon: MessageSquare },
  { id: 'source', label: 'Source', icon: FileSearch },
  { id: 'diff', label: 'Diff vs production', icon: GitCompare },
  { id: 'report', label: 'Report', icon: FileText },
];

function PanelTab({
  panel,
  active,
  onClick,
}: {
  panel: (typeof PANELS)[number];
  active: boolean;
  onClick: () => void;
}) {
  const Icon = panel.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px]',
        active
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden /> {panel.label}
    </button>
  );
}

/**
 * The environment an audit happens in, for one frozen image: a chat with an
 * agent that can read the audited version, that version's source, the diff
 * promoting it would apply to production, and the report itself.
 *
 * Everything here is scoped to the image the freeze pinned — not to whatever
 * the workspace has moved on to since.
 */
export function AuditEnvironment({ bp, canAudit }: { bp: string; canAudit: boolean }) {
  const [panel, setPanel] = useState<Panel>(canAudit ? 'chat' : 'report');
  const [env, setEnv] = useState<AuditEnv | null>(null);
  const [envError, setEnvError] = useState('');

  useEffect(() => {
    let alive = true;
    api.audits
      .env(bp)
      .then((e) => {
        if (alive) setEnv(e);
      })
      .catch((err: unknown) => {
        if (alive) setEnvError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [bp]);

  if (envError) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-[12px] text-muted-foreground">
        Couldn’t read the audit environment: {envError}
      </div>
    );
  }
  if (!env) {
    return (
      <div className="px-3 py-8 text-center text-[13px] text-muted-foreground">Loading…</div>
    );
  }
  if (!env.ready) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-[12px] text-muted-foreground">
        {env.reason ?? 'There is no audit environment for this business process yet.'}
      </div>
    );
  }

  return (
    <div className="flex min-h-[28rem] flex-col rounded-lg border border-border">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-2">
        <div className="flex items-center">
          {PANELS.filter((p) => p.id !== 'chat' || canAudit).map((p) => (
            <PanelTab
              key={p.id}
              panel={p}
              active={panel === p.id}
              onClick={() => setPanel(p.id)}
            />
          ))}
        </div>
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
          auditing <code className="font-mono">{(env.audited_commit ?? '').slice(0, 8) || '—'}</code>
          {env.production_commit ? (
            <>
              {' '}
              against production’s{' '}
              <code className="font-mono">{env.production_commit.slice(0, 8)}</code>
            </>
          ) : (
            <> · production has nothing deployed</>
          )}
          {env.agent?.running === false ? <> · agent not running</> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {panel === 'chat' ? (
          <div className="h-[32rem]">
            <AuditChat bp={bp} />
          </div>
        ) : panel === 'source' ? (
          <AuditSource bp={bp} />
        ) : panel === 'diff' ? (
          <AuditDiff bp={bp} />
        ) : (
          <AuditReport bp={bp} canAudit={canAudit} />
        )}
      </div>
    </div>
  );
}

function AuditSource({ bp }: { bp: string }) {
  const [tree, setTree] = useState<FileTreeNode[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<AuditSearchMatch[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.audits
      .files(bp)
      .then((r) => {
        if (alive) setTree(r.entries);
      })
      .catch(() => {
        if (alive) setTree([]);
      });
    return () => {
      alive = false;
    };
  }, [bp]);

  useEffect(() => {
    if (!openPath) return;
    let alive = true;
    setLoading(true);
    api.audits
      .fileContent(bp, openPath)
      .then((r) => {
        if (alive) setContent(r.content);
      })
      .catch((err: unknown) => {
        if (alive) setContent(`Couldn’t read this file: ${errorMessage(err)}`);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bp, openPath]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) {
      setMatches(null);
      return;
    }
    try {
      const r = await api.audits.search(bp, q);
      setMatches(r.matches);
    } catch (err) {
      toast.error('Search failed', { description: errorMessage(err) });
    }
  };

  return (
    <div className="flex h-[32rem] min-h-0">
      <aside className="flex w-[17rem] shrink-0 flex-col border-r border-border">
        <div className="shrink-0 border-b border-border p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
              if (e.key === 'Escape') {
                setQuery('');
                setMatches(null);
              }
            }}
            placeholder="Search the audited source…"
            className="h-7 w-full rounded border border-border bg-background px-2 text-[12px]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {matches ? (
            matches.length ? (
              <ul className="py-1">
                {matches.map((m, i) => (
                  <li key={`${m.path}:${m.line}:${i}`}>
                    <button
                      type="button"
                      onClick={() => setOpenPath(m.path)}
                      className="block w-full px-2 py-1 text-left hover:bg-muted/50"
                    >
                      <span className="block truncate font-mono text-[11px]">
                        {m.path}:{m.line}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {m.text.trim()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                No matches.
              </div>
            )
          ) : tree && tree.length ? (
            <FileTree
              tree={tree}
              openPath={openPath}
              statusByPath={EMPTY_STATUS}
              onOpen={setOpenPath}
              dragHoverFolder={null}
              onDragHoverChange={NOOP}
            />
          ) : (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
              {tree ? 'No files.' : 'Loading…'}
            </div>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!openPath ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-muted-foreground">
            <FileText className="size-6" aria-hidden />
            Select a file to read the version under audit.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-[11px]">
              <FileText className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate font-mono">{openPath}</span>
              <span className="text-muted-foreground">· read-only</span>
            </div>
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="p-8 text-center text-[13px] text-muted-foreground">
                    Loading viewer…
                  </div>
                }
              >
                <CodeEditor
                  value={content}
                  path={openPath}
                  readOnly
                  onChange={NOOP}
                  onSave={NOOP}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AuditDiff({ bp }: { bp: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.audits
      .diff(bp)
      .then((r) => {
        if (alive) setDiff(r.diff);
      })
      .catch((err: unknown) => {
        if (alive) setDiff(`Couldn’t read the diff: ${errorMessage(err)}`);
      });
    return () => {
      alive = false;
    };
  }, [bp]);
  return (
    <div className="h-[32rem]">
      <DiffView path="production → audited version" diff={diff ?? ''} loading={diff === null} />
    </div>
  );
}

function AuditReport({ bp, canAudit }: { bp: string; canAudit: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.audits
      .report(bp)
      .then((r) => {
        setContent(r.content);
        setDirty(false);
      })
      .catch((err: unknown) => setContent(`Couldn’t read the report: ${errorMessage(err)}`));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable for this bp
  }, [bp]);

  const save = async () => {
    setBusy(true);
    const work = api.audits.saveReport(bp, content ?? '');
    toast.promise(work, {
      loading: 'Saving the audit report…',
      success: 'Audit report saved',
      error: (e: unknown) => `Couldn’t save the report: ${errorMessage(e)}`,
    });
    try {
      await work;
      setDirty(false);
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  const draft = async () => {
    setBusy(true);
    const work = api.audits.draft(bp);
    toast.promise(work, {
      loading: 'The audit agent is reading the version and the diff…',
      success: 'The agent wrote a draft into the report',
      error: (e: unknown) => `The agent couldn’t draft the report: ${errorMessage(e)}`,
    });
    try {
      await work;
      await load();
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  const words = useMemo(
    () => (content ?? '').trim().split(/\s+/).filter(Boolean).length,
    [content],
  );

  return (
    <div className="flex h-[32rem] flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {words > 0 ? `${words} words` : 'Nothing written yet'} · markdown ·{' '}
          {canAudit ? 'saved against the frozen image' : 'read-only for your role'}
        </span>
        {canAudit && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void draft()}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
              title="Have the audit agent read the audited version and its diff, and write a draft"
            >
              <Sparkles className="size-3.5" aria-hidden /> Draft with the agent
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              <Save className="size-3.5" aria-hidden /> Save
            </button>
          </div>
        )}
      </div>
      {content === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
        </div>
      ) : (
        <textarea
          value={content}
          readOnly={!canAudit}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
          placeholder="What changed, what risk each change carries, what you verified, and what you could not verify."
          className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-[12px] outline-none"
        />
      )}
    </div>
  );
}
