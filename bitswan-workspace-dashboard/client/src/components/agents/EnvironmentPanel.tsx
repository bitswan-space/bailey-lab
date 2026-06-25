import { useMemo, useRef, useState } from 'react';
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  Cog,
  ExternalLink,
  Globe,
  KeyRound,
  Layout,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import { api } from '@/lib/api';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { SecretsEditor } from '@/components/secrets/SecretsEditor';
import { cn } from '@/lib/utils';

/**
 * The Agents-screen ENVIRONMENT panel (wireframe: Workspace Dashboard →
 * Agents, right column). Lists the business process's two kinds of
 * container:
 *
 *   - Frontends: reachable through Bailey, access controlled by the share
 *     button (no public/internal type — all frontends are the same kind).
 *     "Add frontend" scaffolds one directly.
 *   - Worker containers: private backends on the Docker network. "Add worker
 *     container" offers a type (only the Go backend wired today).
 *
 * Full CRUD wired to the gitops endpoints; the automations SSE snapshot
 * drives the list. Rename is an inline input; status is the dot on the
 * right. Matches the wireframe's FrontendRow layout.
 */

interface Props {
  bp: string;
  copy: string;
}

type Status = 'running' | 'failed' | 'stopped';

interface Item {
  name: string;
  url: string | null;
  status: Status;
  expose: boolean;
}

const WORKER_TYPES: { type: string; label: string }[] = [
  { type: 'go', label: 'Go backend' },
  { type: 'fastapi', label: 'FastAPI (Python)' },
];

export function EnvironmentPanel({ bp, copy }: Props) {
  const { automations } = useAutomations();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = nothing being renamed
  const [renaming, setRenaming] = useState<string | null>(null);
  // A pending "add" awaiting the user to name it. null = nothing being added.
  // eslint-disable-next-line no-restricted-syntax -- null = not adding
  const [adding, setAdding] = useState<
    { kind: 'frontend' } | { kind: 'worker'; type: string } | null
  >(null);

  const { frontends, workers } = useMemo(() => {
    const prefix = `copies/${copy}/${bp}/`;
    const byName = new Map<string, Item>();
    for (const a of automations) {
      const rel = a.relative_path ?? '';
      if (!rel.startsWith(prefix)) continue;
      const name = a.automation_name ?? a.name;
      const st = a.state ?? a.status ?? '';
      const status: Status =
        st === 'running' || st === 'restarting'
          ? 'running'
          : st === 'failed' || st === 'dead' || st === 'exited'
            ? 'failed'
            : 'stopped';
      const prev = byName.get(name);
      byName.set(name, {
        name,
        url: a.automation_url ?? prev?.url ?? null,
        status: status === 'running' ? 'running' : (prev?.status ?? status),
        expose: !!a.expose || !!prev?.expose,
      });
    }
    const all = [...byName.values()];
    const byNameAsc = (a: Item, b: Item) => a.name.localeCompare(b.name);
    return {
      frontends: all.filter((i) => i.expose).sort(byNameAsc),
      workers: all.filter((i) => !i.expose).sort(byNameAsc),
    };
  }, [automations, bp, copy]);

  const mutate = async (label: string, work: Promise<unknown>) => {
    setBusy(true);
    try {
      await work;
    } catch (e) {
      toast.error(`${label} failed`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  // A non-colliding default name, e.g. new-frontend, new-frontend-2.
  const uniqueName = (base: string, taken: Item[]): string => {
    const names = new Set(taken.map((t) => t.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base}-${i}`)) return `${base}-${i}`;
  };

  // Clicking an "add" button doesn't scaffold immediately — it opens a draft
  // row so the user names the automation first. commitAdd fires the scaffold
  // (which now also auto-deploys it) once they confirm a non-empty name.
  const commitAdd = (
    draft: { kind: 'frontend' } | { kind: 'worker'; type: string },
    rawName: string,
  ) => {
    setAdding(null);
    const name = rawName.trim();
    if (!name) return; // empty / cancelled
    if (draft.kind === 'frontend') {
      void mutate('Add frontend', api.addFrontend({ bp, name, copy }));
    } else {
      void mutate('Add worker', api.addWorker({ bp, name, type: draft.type, copy }));
    }
  };

  const doRename = (oldName: string, next: string) => {
    setRenaming(null);
    const clean = next.trim();
    if (!clean || clean === oldName) return;
    void mutate(
      'Rename',
      api.renameAutomation({ bp, old_name: oldName, new_name: clean, copy }),
    );
  };

  const remove = (item: Item, kind: string) => {
    if (!window.confirm(`Delete ${kind} "${item.name}"? This cannot be undone.`))
      return;
    // DELETE is keyed by deployment_id, which for a source automation is its
    // directory name within the BP.
    void mutate('Delete', api.removeAutomation(item.name));
  };

  if (collapsed) {
    return (
      <div className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-background pt-2.5">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand panel"
          className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
        >
          <PanelRightOpen className="size-3.5" aria-hidden />
        </button>
        <div className="my-1.5 h-px w-6 bg-border" />
        <Layout className="size-3.5 text-muted-foreground/60" aria-hidden />
        <Boxes className="mt-2 size-3.5 text-muted-foreground/60" aria-hidden />
        <KeyRound className="mt-2 size-3.5 text-muted-foreground/60" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-center border-b border-border px-3 py-2.5">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Environment
        </span>
        {busy && (
          <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" aria-hidden />
        )}
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse panel"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="size-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Section icon={Layout} title="Frontends" count={frontends.length}>
          {frontends.length === 0 && <Empty>No frontends yet.</Empty>}
          {frontends.map((f) => (
            <Row
              key={f.name}
              item={f}
              icon={Globe}
              iconClass="text-blue-500"
              renaming={renaming === f.name}
              busy={busy}
              onStartRename={() => setRenaming(f.name)}
              onRename={(next) => doRename(f.name, next)}
              onCancelRename={() => setRenaming(null)}
              onDelete={() => remove(f, 'frontend')}
            />
          ))}
          {adding?.kind === 'frontend' ? (
            <DraftRow
              icon={Globe}
              iconClass="text-blue-500"
              defaultName={uniqueName('new-frontend', frontends)}
              busy={busy}
              onCommit={(name) => commitAdd({ kind: 'frontend' }, name)}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <AddButton
              onClick={() => setAdding({ kind: 'frontend' })}
              disabled={busy}
              label="Add frontend"
            />
          )}
        </Section>

        <Section icon={Boxes} title="Worker containers" count={workers.length}>
          {workers.length === 0 && <Empty>No worker containers yet.</Empty>}
          {workers.map((w) => (
            <Row
              key={w.name}
              item={w}
              icon={Cog}
              iconClass="text-muted-foreground"
              renaming={renaming === w.name}
              busy={busy}
              onStartRename={() => setRenaming(w.name)}
              onRename={(next) => doRename(w.name, next)}
              onCancelRename={() => setRenaming(null)}
              onDelete={() => remove(w, 'worker container')}
            />
          ))}
          {adding?.kind === 'worker' ? (
            <DraftRow
              icon={Cog}
              iconClass="text-muted-foreground"
              defaultName={uniqueName('new-worker', workers)}
              busy={busy}
              onCommit={(name) => commitAdd({ kind: 'worker', type: adding.type }, name)}
              onCancel={() => setAdding(null)}
            />
          ) : (
            <AddWorkerButton
              onAdd={(type) => setAdding({ kind: 'worker', type })}
              disabled={busy}
            />
          )}
        </Section>

        <DevSecrets bp={bp} />
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof Layout;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-2.5 text-muted-foreground/60" aria-hidden />
        {title}
        <span className="ml-auto font-medium text-muted-foreground/60">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Row({
  item,
  icon: Icon,
  iconClass,
  renaming,
  busy,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  item: Item;
  icon: typeof Globe;
  iconClass: string;
  renaming: boolean;
  busy: boolean;
  onStartRename: () => void;
  onRename: (next: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dot =
    item.status === 'running'
      ? 'bg-emerald-600'
      : item.status === 'failed'
        ? 'bg-red-600'
        : 'bg-muted-foreground/40';
  const canOpen = !!item.url && item.status === 'running';
  return (
    <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted/60">
      <Icon className={cn('size-3 shrink-0', iconClass)} aria-hidden />
      {renaming ? (
        <input
          ref={inputRef}
          autoFocus
          defaultValue={item.name}
          onBlur={(e) => onRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onCancelRename();
          }}
          className="min-w-0 flex-1 rounded border border-foreground/60 bg-background px-1.5 py-0.5 font-mono text-xs outline-none"
        />
      ) : (
        <a
          href={canOpen ? (item.url ?? undefined) : undefined}
          target="_blank"
          rel="noreferrer"
          title={canOpen ? `Open ${item.url}` : `${item.name} — not running`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-xs no-underline',
            canOpen ? 'cursor-pointer text-foreground' : 'cursor-default text-muted-foreground',
          )}
        >
          {item.name}
          {canOpen && <ExternalLink className="size-2.5 shrink-0 opacity-60" aria-hidden />}
        </a>
      )}
      <span className={cn('size-1.5 shrink-0 rounded-full', dot)} title={item.status} />
      {!renaming && (
        <div className="flex opacity-60 transition-opacity group-hover:opacity-100">
          <button
            onClick={onStartRename}
            disabled={busy}
            title="Rename"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <Pencil className="size-2.5" aria-hidden />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            title="Delete"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-30"
          >
            <Trash2 className="size-2.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

function AddButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-1 flex h-[30px] items-center justify-center gap-1.5 rounded-md border-[1.5px] border-dashed border-border bg-background text-xs font-medium text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-40"
    >
      <Plus className="size-3" aria-hidden />
      {label}
    </button>
  );
}

function AddWorkerButton({
  onAdd,
  disabled,
}: {
  onAdd: (type: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const only = WORKER_TYPES.length === 1 ? WORKER_TYPES[0] : undefined;
  if (only) {
    return (
      <AddButton
        onClick={() => onAdd(only.type)}
        disabled={disabled}
        label="Add worker container"
      />
    );
  }
  return (
    <div className="relative">
      <AddButton onClick={() => setOpen((o) => !o)} disabled={disabled} label="Add worker container" />
      {open && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-md">
          {WORKER_TYPES.map((w) => (
            <button
              key={w.type}
              onClick={() => {
                setOpen(false);
                onAdd(w.type);
              }}
              className="block w-full px-3 py-2 text-left text-xs text-foreground hover:bg-muted"
            >
              {w.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DraftRow({
  icon: Icon,
  iconClass,
  defaultName,
  busy,
  onCommit,
  onCancel,
}: {
  icon: typeof Globe;
  iconClass: string;
  defaultName: string;
  busy: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  // Escape cancels; without this guard the resulting blur would still commit.
  const cancelled = useRef(false);
  return (
    <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1">
      <Icon className={cn('size-3 shrink-0', iconClass)} aria-hidden />
      <input
        autoFocus
        defaultValue={defaultName}
        disabled={busy}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          if (!cancelled.current) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            cancelled.current = true;
            onCancel();
          }
        }}
        className="min-w-0 flex-1 rounded border border-foreground/60 bg-background px-1.5 py-0.5 font-mono text-xs outline-none"
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[11px] text-muted-foreground">{children}</div>;
}

function DevSecrets({ bp }: { bp: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <KeyRound className="size-2.5 text-muted-foreground/60" aria-hidden />
        Dev secrets
        {open ? (
          <ChevronUp className="ml-auto size-3.5 text-muted-foreground/60" aria-hidden />
        ) : (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/60" aria-hidden />
        )}
      </button>
      {open ? (
        // Shared editor scoped to the dev realm — the same values the
        // Deployments → Secrets "Development" stage edits (dev/live-dev share).
        <SecretsEditor bp={bp} stage="dev" stageLabel="Development" compact />
      ) : (
        <div className="text-[11px] text-muted-foreground">
          Environment variables &amp; API keys for this business process&apos;s dev
          stage (shared with live-dev). Click to edit.
        </div>
      )}
    </div>
  );
}
