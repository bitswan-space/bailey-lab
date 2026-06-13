import { useMemo, useState } from 'react';
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  KeyRound,
  Layout,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { cn } from '@/lib/utils';
import type { DeployedAutomation } from '@/types/automation';

/**
 * The Agents-screen ENVIRONMENT panel (wireframe: Workspace Dashboard →
 * Agents). Lists the business process's two kinds of container:
 *
 *   - Frontends: exposed through Bailey, shareable via the Bailey share
 *     button. Exactly one kind — "Add frontend" scaffolds it directly.
 *   - Worker containers: private backends, reachable only on the Docker
 *     network. Multiple types ("Add worker container" → type menu); only the
 *     Python FastAPI worker is wired today.
 *
 * Full CRUD on both, wired to the gitops endpoints; the automations SSE
 * snapshot refreshes the list. Dev secrets is a collapsible note for now.
 */

interface Props {
  bp: string;
  worktree: string;
}

type Item = {
  name: string;
  relativePath: string;
  url: string | null;
  running: boolean;
  expose: boolean;
};

// Worker types offered by "Add worker container". Only fastapi is wired in
// gitops today; the menu is the seam for future types.
const WORKER_TYPES: { type: string; label: string }[] = [
  { type: 'fastapi', label: 'Python FastAPI' },
];

export function EnvironmentPanel({ bp, worktree }: Props) {
  const { automations } = useAutomations();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);

  // The BP's automations in this worktree, deduped by automation name (a
  // single automation can appear as several stage entries). Split by
  // `expose`: frontends vs worker containers.
  const { frontends, workers } = useMemo(() => {
    const prefix = `worktrees/${worktree}/${bp}/`;
    const byName = new Map<string, Item>();
    for (const a of automations) {
      const rel = a.relative_path ?? '';
      if (!rel.startsWith(prefix)) continue;
      const name = a.automation_name ?? a.name;
      const running = a.state === 'running' || a.status === 'running';
      const prev = byName.get(name);
      byName.set(name, {
        name,
        relativePath: rel,
        url: a.automation_url ?? prev?.url ?? null,
        running: running || !!prev?.running,
        // expose is definition-based; OR across this automation's entries.
        expose: !!a.expose || !!prev?.expose,
      });
    }
    const all = [...byName.values()];
    return {
      frontends: all.filter((i) => i.expose).sort(byName_),
      workers: all.filter((i) => !i.expose).sort(byName_),
    };
  }, [automations, bp, worktree]);

  const runMutation = async (label: string, work: Promise<unknown>) => {
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

  const addFrontend = () => {
    const name = window.prompt('Name for the new frontend:', 'frontend');
    if (!name) return;
    void runMutation(
      'Add frontend',
      api.addFrontend({ bp, name, worktree }),
    );
  };

  const addWorker = (type: string) => {
    const def = WORKER_TYPES.find((w) => w.type === type);
    const name = window.prompt(
      `Name for the new ${def?.label ?? type} worker:`,
      'backend',
    );
    if (!name) return;
    void runMutation('Add worker', api.addWorker({ bp, name, type, worktree }));
  };

  const rename = (item: Item) => {
    const next = window.prompt(`Rename "${item.name}" to:`, item.name);
    if (!next || next === item.name) return;
    void runMutation(
      'Rename',
      api.renameAutomation({ bp, old_name: item.name, new_name: next, worktree }),
    );
  };

  const remove = (item: Item, kind: string) => {
    if (!window.confirm(`Delete ${kind} "${item.name}"? This cannot be undone.`))
      return;
    // The DELETE endpoint is keyed by deployment_id, which for an undeployed
    // source automation equals its directory name within the BP.
    void runMutation('Delete', api.removeAutomation(item.name));
  };

  if (collapsed) {
    return (
      <div className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-background pt-2.5">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand panel"
          className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground"
        >
          <Layout className="size-3.5" aria-hidden />
        </button>
        <Boxes className="mt-2 size-3.5 text-muted-foreground/60" aria-hidden />
        <KeyRound className="mt-2.5 size-3.5 text-muted-foreground/60" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-center border-b border-border px-3 py-2.5">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Environment
        </span>
        {busy && <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" aria-hidden />}
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse panel"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Layout className="size-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Section icon={<Layout className="size-3" aria-hidden />} title="Frontends" count={frontends.length}>
          {frontends.length === 0 && <Empty>No frontends yet.</Empty>}
          {frontends.map((f) => (
            <Row
              key={f.name}
              item={f}
              busy={busy}
              onRename={() => rename(f)}
              onDelete={() => remove(f, 'frontend')}
            />
          ))}
          <AddButton onClick={addFrontend} disabled={busy} label="Add frontend" />
        </Section>

        <Section icon={<Boxes className="size-3" aria-hidden />} title="Worker containers" count={workers.length}>
          {workers.length === 0 && <Empty>No worker containers yet.</Empty>}
          {workers.map((w) => (
            <Row
              key={w.name}
              item={w}
              busy={busy}
              onRename={() => rename(w)}
              onDelete={() => remove(w, 'worker container')}
            />
          ))}
          <AddWorkerButton onAdd={addWorker} disabled={busy} />
        </Section>

        <DevSecrets />
      </div>
    </div>
  );
}

function byName_(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name);
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="text-muted-foreground/60">{icon}</span>
        {title}
        <span className="ml-auto font-medium text-muted-foreground/60">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Row({
  item,
  busy,
  onRename,
  onDelete,
}: {
  item: Item;
  busy: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-muted/60">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          item.running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
        )}
        title={item.running ? 'running' : 'stopped'}
      />
      <span className="flex-1 truncate text-[13px] text-foreground">{item.name}</span>
      {item.url && (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title="Open"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
      <button
        onClick={onRename}
        disabled={busy}
        title="Rename"
        className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 disabled:opacity-30"
      >
        <Pencil className="size-3" aria-hidden />
      </button>
      <button
        onClick={onDelete}
        disabled={busy}
        title="Delete"
        className="text-muted-foreground opacity-0 hover:text-red-600 group-hover:opacity-100 disabled:opacity-30"
      >
        <Trash2 className="size-3" aria-hidden />
      </button>
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
      className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1.5 text-[12px] text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-40"
    >
      <Plus className="size-3" aria-hidden />
      {label}
    </button>
  );
}

// "Add worker container" with a type menu. One type today (FastAPI); if more
// are added it becomes a real chooser.
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
              className="block w-full px-3 py-2 text-left text-[12px] text-foreground hover:bg-muted"
            >
              {w.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[11px] text-muted-foreground">{children}</div>;
}

function DevSecrets() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <KeyRound className="size-3 text-muted-foreground/60" aria-hidden />
        Dev secrets
        {open ? (
          <ChevronUp className="ml-auto size-3.5 text-muted-foreground/60" aria-hidden />
        ) : (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/60" aria-hidden />
        )}
      </button>
      {open ? (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          Secret editing isn’t wired up yet — env vars &amp; API keys for this
          worktree will live here.
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          Environment variables &amp; API keys for this worktree.
        </div>
      )}
    </div>
  );
}
