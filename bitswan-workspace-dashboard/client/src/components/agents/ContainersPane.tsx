import { useEffect, useMemo, useState } from 'react';
import { Cog, Globe, Hammer, Loader2, Play, RotateCcw, Square } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { deployBpWithToast } from '@/lib/deployBp';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { OverviewPane } from '@/components/automations/inspect/OverviewPane';
import { LogsPane } from '@/components/automations/inspect/LogsPane';
import { BuildLogsPane } from '@/components/automations/inspect/BuildLogsPane';
import { cn } from '@/lib/utils';

/**
 * Containers sub-tab of the Coding Agent screen (wireframe: Coding Agent →
 * Containers). Master-detail: a left list of the business process's
 * containers (frontends + worker containers) and a right Inspect view
 * (Overview + Logs) for the selected one, with Restart/Stop/Start.
 *
 * Reuses the dashboard's existing inspect panes (OverviewPane / LogsPane) and
 * lifecycle endpoints. The wireframe's Metrics and Events sub-tabs are
 * omitted — they have no backend, like Plan/Notes/Browser.
 */
interface Props {
  bp: string;
  copy: string;
  active: boolean;
}

interface Container {
  name: string;
  deploymentId: string | null;
  status: 'running' | 'failed' | 'stopped';
  expose: boolean;
}

type Detail = 'overview' | 'logs' | 'build';

export function ContainersPane({ bp, copy, active }: Props) {
  const { automations } = useAutomations();

  const containers = useMemo<Container[]>(() => {
    const prefix = `copies/${copy}/${bp}/`;
    const byName = new Map<string, Container>();
    for (const a of automations) {
      const rel = a.relative_path ?? '';
      if (!rel.startsWith(prefix)) continue;
      const name = a.automation_name ?? a.name;
      const st = a.state ?? a.status ?? '';
      const status: Container['status'] =
        st === 'running' || st === 'restarting'
          ? 'running'
          : st === 'failed' || st === 'dead' || st === 'exited'
            ? 'failed'
            : 'stopped';
      const prev = byName.get(name);
      byName.set(name, {
        name,
        deploymentId: a.deployment_id ?? prev?.deploymentId ?? null,
        status: status === 'running' ? 'running' : (prev?.status ?? status),
        expose: !!a.expose || !!prev?.expose,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [automations, bp, copy]);

  // eslint-disable-next-line no-restricted-syntax -- null = nothing selected
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail>('overview');
  const [busy, setBusy] = useState(false);
  const [deploying, setDeploying] = useState(false);

  // Rebuild every image in this business process and redeploy the copy's
  // live-dev stage (the working preview these containers belong to). Reuses
  // the BP deploy task + progress toast; gitops rebuilds from the copy state.
  const rebuildRedeploy = async () => {
    setDeploying(true);
    try {
      await deployBpWithToast({
        bp,
        stage: 'live-dev',
        copy,
        loading: `Rebuilding & redeploying ${bp}…`,
        success: `${bp} rebuilt & redeployed`,
        failurePrefix: `Rebuild & redeploy of ${bp} failed`,
      });
    } finally {
      setDeploying(false);
    }
  };

  // Keep a valid selection as the list changes.
  useEffect(() => {
    const first = containers[0];
    if (!first) {
      setSelectedName(null);
    } else if (!containers.some((c) => c.name === selectedName)) {
      setSelectedName(first.name);
    }
  }, [containers, selectedName]);

  const selected = containers.find((c) => c.name === selectedName) ?? null;

  // The image build checksum lives in the automation's `automation.toml` as
  // image = "internal/<root>:sha<checksum>" (gitops writes the BUILT base image
  // there). That checksum names the build-log dir; the running container's
  // version_hash is the thin app layer and has no log. Resolve it lazily when
  // the Build logs tab is open.
  // eslint-disable-next-line no-restricted-syntax -- null = no built image / not resolved
  const [buildChecksum, setBuildChecksum] = useState<string | null>(null);
  useEffect(() => {
    setBuildChecksum(null);
    const name = selected?.name;
    if (!name || detail !== 'build' || !active) return;
    let cancelled = false;
    api.copyFiles
      .content(copy, `${bp}/${name}/automation.toml`)
      .then((r) => {
        if (cancelled || 'error' in r) return;
        const m = r.content.match(/image\s*=\s*["'][^"']*:sha([0-9a-f]+)["']/i);
        if (m?.[1]) setBuildChecksum(m[1]);
      })
      .catch(() => {
        /* leave null → BuildLogsPane shows its empty state */
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.name, bp, copy, detail, active]);

  const lifecycle = async (verb: 'restart' | 'stop' | 'start', c: Container) => {
    if (!c.deploymentId) return;
    setBusy(true);
    try {
      if (verb === 'restart') await api.restartAutomation(c.deploymentId);
      else if (verb === 'stop') await api.stopAutomation(c.deploymentId);
      else await api.startAutomation(c.deploymentId);
    } catch (e) {
      toast.error(`${verb} failed`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* BP-level toolbar: rebuild every image + redeploy this copy. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2">
        <span className="truncate text-[11px] text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">Business process</span>{' '}
          <span className="font-mono text-foreground">{bp}</span>
        </span>
        <button
          type="button"
          onClick={rebuildRedeploy}
          disabled={deploying}
          title="Rebuild every image in this business process and redeploy the copy"
          className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
        >
          {deploying ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Hammer className="size-3.5" aria-hidden />
          )}
          Rebuild &amp; redeploy
        </button>
      </div>

      {/* Master-detail: container list + inspect. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: container list */}
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Containers
          <span className="ml-auto font-medium text-muted-foreground/60">
            {containers.length}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {containers.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No containers in this business process yet.
            </div>
          ) : (
            containers.map((c) => (
              <button
                key={c.name}
                onClick={() => setSelectedName(c.name)}
                className={cn(
                  'flex w-full items-center gap-2.5 border-l-2 px-3 py-2.5 text-left',
                  c.name === selectedName
                    ? 'border-foreground bg-muted/60'
                    : 'border-transparent hover:bg-muted/40',
                )}
              >
                {c.expose ? (
                  <Globe className="size-3.5 shrink-0 text-blue-500" aria-hidden />
                ) : (
                  <Cog className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="flex-1 truncate font-mono text-xs text-foreground">
                  {c.name}
                </span>
                <StatusDot status={c.status} />
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Right: inspect detail */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a container to inspect.
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm font-semibold text-foreground">
                  Inspect {selected.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  Local container — logs &amp; details for this copy
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {busy && (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
                )}
                {selected.status === 'running' ? (
                  <>
                    <LifecycleBtn
                      icon={<RotateCcw className="size-3" aria-hidden />}
                      label="Restart"
                      disabled={busy || !selected.deploymentId}
                      onClick={() => lifecycle('restart', selected)}
                    />
                    <LifecycleBtn
                      icon={<Square className="size-3" aria-hidden />}
                      label="Stop"
                      danger
                      disabled={busy || !selected.deploymentId}
                      onClick={() => lifecycle('stop', selected)}
                    />
                  </>
                ) : (
                  <LifecycleBtn
                    icon={<Play className="size-3" aria-hidden />}
                    label="Start"
                    disabled={busy || !selected.deploymentId}
                    onClick={() => lifecycle('start', selected)}
                  />
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4 border-b border-border px-5">
              <DetailTab active={detail === 'overview'} onClick={() => setDetail('overview')} label="Overview" />
              <DetailTab active={detail === 'logs'} onClick={() => setDetail('logs')} label="Logs" />
              <DetailTab active={detail === 'build'} onClick={() => setDetail('build')} label="Build logs" />
            </div>

            {detail === 'build' ? (
              // Build logs key off the image checksum, not the running
              // deployment — viewable even when the container isn't up.
              <div className="min-h-0 flex-1 overflow-hidden">
                <BuildLogsPane checksum={buildChecksum} active={active && detail === 'build'} />
              </div>
            ) : !selected.deploymentId ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                This container isn’t deployed yet — deploy it to inspect.
              </div>
            ) : detail === 'overview' ? (
              <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                <OverviewPane deploymentId={selected.deploymentId} />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden">
                <LogsPane deploymentId={selected.deploymentId} active={active && detail === 'logs'} />
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Container['status'] }) {
  const cls =
    status === 'running'
      ? 'bg-emerald-600'
      : status === 'failed'
        ? 'bg-red-600'
        : 'bg-muted-foreground/40';
  return <span className={cn('size-1.5 shrink-0 rounded-full', cls)} title={status} />;
}

function DetailTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-10 items-center border-b-2 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function LifecycleBtn({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40',
        danger ? 'text-red-600' : 'text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
