import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Play, RotateCw, Square } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { api } from '@/api';
import type {
  AutomationStage,
  AutomationState,
  DeployedAutomation,
  DockerInspect,
} from '@/types';

export interface InspectStage {
  id: AutomationStage;
  label: string;
  automation: DeployedAutomation | undefined;
}

interface InspectModalProps {
  open: boolean;
  onClose: () => void;
  name: string;
  stages: InspectStage[];
  mode: 'deployments' | 'liveDev';
}

const RUNNING_STATES = new Set(['running', 'starting', 'created', 'restarting', 'paused']);
const STOPPED_STATES = new Set(['exited', 'dead', 'paused']);

export function InspectModal({ open, onClose, name, stages, mode }: InspectModalProps) {
  const [stageId, setStageId] = useState<AutomationStage>(stages[0]?.id ?? 'dev');
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');

  // Reset state when the modal is reopened for a different automation.
  useEffect(() => {
    if (open) {
      setStageId(stages[0]?.id ?? 'dev');
      setTab('overview');
    }
  }, [open, name, stages]);

  const stage = useMemo(
    () => stages.find((s) => s.id === stageId) ?? stages[0],
    [stages, stageId],
  );
  const aut = stage?.automation;
  const deploymentId = aut?.deployment_id ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-7xl flex-col gap-0 overflow-hidden p-0">
        <header className="flex items-center gap-2.5 border-b border-border px-5 py-3.5 pr-12">
          <Activity className="size-4 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              Inspect <span className="font-mono">{name}</span>
            </DialogTitle>
            <div className="text-xs text-muted-foreground">
              {mode === 'liveDev'
                ? 'Local container — logs and details for this worktree'
                : 'Container details and logs — per stage'}
            </div>
          </div>
          <ActionButtons deploymentId={deploymentId} state={aut?.state ?? null} />
        </header>

        {mode === 'deployments' && stages.length > 1 && (
          <div className="border-b border-border bg-muted/30 px-5 py-1.5">
            <Tabs value={stageId} onValueChange={(v) => setStageId(v as AutomationStage)}>
              <TabsList className="bg-transparent p-0">
                {stages.map((s) => (
                  <TabsTrigger key={s.id} value={s.id} className="data-[state=active]:bg-background">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        )}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as 'overview' | 'logs')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-5 mt-3 w-fit shrink-0 self-start bg-muted/40">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <OverviewPane deploymentId={deploymentId} />
          </TabsContent>

          <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden">
            <LogsPane deploymentId={deploymentId} active={tab === 'logs' && open} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

interface ActionButtonsProps {
  deploymentId: string | null;
  state: AutomationState | null;
}

function ActionButtons({ deploymentId, state }: ActionButtonsProps) {
  const [inFlight, setInFlight] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRunning = state ? RUNNING_STATES.has(state) : false;
  const isStopped = state ? STOPPED_STATES.has(state) : false;
  const disabled = !deploymentId;

  const run = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      if (!deploymentId) return;
      setInFlight(action);
      setError(null);
      try {
        if (action === 'start') await api.startAutomation(deploymentId);
        else if (action === 'stop') await api.stopAutomation(deploymentId);
        else await api.restartAutomation(deploymentId);
      } catch (err) {
        setError(`${action} failed: ${String(err)}`);
      } finally {
        setInFlight(null);
      }
    },
    [deploymentId],
  );

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('start')}
        disabled={disabled || inFlight !== null || isRunning}
      >
        <Play />
        Start
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('stop')}
        disabled={disabled || inFlight !== null || isStopped || !isRunning}
      >
        <Square />
        Stop
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => run('restart')}
        disabled={disabled || inFlight !== null || !isRunning}
      >
        <RotateCw className={cn(inFlight === 'restart' && 'animate-spin')} />
        Restart
      </Button>
    </div>
  );
}

function OverviewPane({ deploymentId }: { deploymentId: string | null }) {
  const [containers, setContainers] = useState<DockerInspect[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!deploymentId) {
      setContainers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setIdx(0);
    api
      .inspectAutomation(deploymentId)
      .then((rows) => {
        if (!cancelled) setContainers(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentId]);

  if (!deploymentId) {
    return <EmptyHint>Not deployed for this stage.</EmptyHint>;
  }
  if (loading) return <EmptyHint>Loading container details…</EmptyHint>;
  if (error) return <EmptyHint>Failed to load: {error}</EmptyHint>;
  if (containers.length === 0)
    return <EmptyHint>No container found for this deployment.</EmptyHint>;

  const c = containers[idx]!;
  return (
    <div className="flex flex-col gap-4">
      {containers.length > 1 && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Container {idx + 1} of {containers.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIdx((i) => Math.min(containers.length - 1, i + 1))}
              disabled={idx === containers.length - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InspectGroup heading="Identity" rows={identityRows(c)} />
        <InspectGroup heading="Image" rows={imageRows(c)} />
        <InspectGroup heading="Network" rows={networkRows(c)} />
        <InspectGroup heading="Resources" rows={resourceRows(c)} />
        <InspectGroup heading="Mounts" rows={mountRows(c)} fullSpan={c.Mounts && c.Mounts.length > 4} />
        {c.Config?.Healthcheck && (
          <InspectGroup heading="Health check" rows={healthRows(c)} />
        )}
      </div>
    </div>
  );
}

interface InspectGroupProps {
  heading: string;
  rows: Array<[string, React.ReactNode]>;
  fullSpan?: boolean;
}

function InspectGroup({ heading, rows, fullSpan }: InspectGroupProps) {
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

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const mono = (s: string | undefined | null) =>
  s ? <span className="font-mono">{s}</span> : null;

function identityRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const healthy = c.State?.Health?.Status === 'healthy';
  return [
    ['Container ID', mono(c.Id?.slice(0, 12))],
    ['Name', c.Name?.replace(/^\//, '') ?? null],
    ['Created', formatTimestamp(c.Created)],
    [
      'Status',
      c.State?.Status ? (
        <span className="inline-flex items-center gap-2">
          {c.State.Status}
          {healthy && (
            <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
              healthy
            </Badge>
          )}
        </span>
      ) : null,
    ],
    ['Restart count', c.RestartCount ?? 0],
  ];
}

function imageRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const commit = c.Config?.Labels?.['gitops.commit'];
  return [
    ['Repository', c.Config?.Image ?? null],
    ['Digest', mono(c.Image)],
    ['Commit', mono(commit ? commit.slice(0, 12) : undefined)],
    ['Created', formatTimestamp(c.Created)],
  ];
}

function networkRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const networks = c.NetworkSettings?.Networks ?? {};
  const firstNet = Object.entries(networks)[0];
  const portStrs = Object.entries(c.NetworkSettings?.Ports ?? {})
    .map(([key, bindings]) => {
      if (!bindings || bindings.length === 0) return key;
      const hostPort = bindings[0]?.HostPort;
      return hostPort ? `${key} → ${hostPort}` : key;
    });
  return [
    ['Network', firstNet?.[0] ?? null],
    ['IP address', mono(firstNet?.[1]?.IPAddress)],
    ['Ports', portStrs.length > 0 ? mono(portStrs.join(', ')) : null],
    ['Hostname', mono(c.Config?.Hostname)],
  ];
}

function resourceRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const cpus = c.HostConfig?.NanoCpus;
  const mem = c.HostConfig?.Memory;
  return [
    ['CPU limit', cpus ? `${(cpus / 1e9).toFixed(2)} cores` : 'unlimited'],
    ['Memory limit', mem ? formatBytes(mem) : 'unlimited'],
    ['PID', c.State?.Pid ?? null],
  ];
}

function mountRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const mounts = c.Mounts ?? [];
  if (mounts.length === 0) return [['Mounts', <span key="m" className="text-muted-foreground">none</span>]];
  return mounts.map((m, i): [string, React.ReactNode] => [
    m.Destination ?? '?',
    <span key={i} className="flex items-center gap-2">
      {mono(m.Source ?? '?')}
      <span className="text-muted-foreground">
        ({m.Type ?? 'mount'}
        {m.RW === false ? ', ro' : ''})
      </span>
    </span>,
  ]);
}

function healthRows(c: DockerInspect): Array<[string, React.ReactNode]> {
  const hc = c.Config?.Healthcheck;
  if (!hc) return [];
  const test = hc.Test ? hc.Test.filter((s) => s !== 'CMD' && s !== 'CMD-SHELL').join(' ') : null;
  const interval = hc.Interval ? `${(hc.Interval / 1e9).toFixed(0)}s` : null;
  return [
    ['Test', mono(test)],
    ['Interval', interval],
    ['Status', c.State?.Health?.Status ?? null],
    ['Failing streak', c.State?.Health?.FailingStreak ?? 0],
  ];
}

function formatTimestamp(s: string | undefined | null): string | null {
  if (!s) return null;
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const MAX_LOG_LINES = 500;

// Shape of the JSON payload gitops puts on `event: log` (and `event: error`).
// See bitswan-gitops/app/services/automation_service.py:stream_automation_logs.
interface LogEntry {
  line: string;
  stream?: 'stdout' | 'stderr' | string;
}

interface ErrorEntry {
  message: string;
  replica?: number;
}

function LogsPane({ deploymentId, active }: { deploymentId: string | null; active: boolean }) {
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    setLines([]);
    setError(null);
    setEnded(false);
    if (!deploymentId || !active) return;

    const es = new EventSource(
      `/api/automations/${encodeURIComponent(deploymentId)}/logs`,
      { withCredentials: true },
    );

    const append = (entry: LogEntry) => {
      setLines((prev) => {
        const next =
          prev.length >= MAX_LOG_LINES ? prev.slice(prev.length - MAX_LOG_LINES + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    };

    // Gitops emits named SSE events with JSON payloads, not unnamed messages.
    // - event: metadata (replica count + container info) — ignored for now
    // - event: log      ({replica, line, stream})
    // - event: error    ({replica?, message})
    // - event: end      ({})
    es.addEventListener('log', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as LogEntry;
        if (typeof payload.line === 'string') append(payload);
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener('error', (ev) => {
      // The 'error' event fires both for upstream-sent errors AND for
      // EventSource's own transport errors. Only the former carries data.
      const data = (ev as MessageEvent).data;
      if (typeof data === 'string' && data.length > 0) {
        try {
          const payload = JSON.parse(data) as ErrorEntry;
          if (payload.message) setError(payload.message);
        } catch {
          // ignore
        }
      }
    });
    es.addEventListener('end', () => {
      setEnded(true);
      es.close();
    });
    es.onerror = () => {
      // Transport-level error (network blip). EventSource auto-reconnects;
      // surface this as a soft notice rather than tearing down state.
      if (!ended) setError('Log stream disconnected — reconnecting…');
    };

    return () => es.close();
  }, [deploymentId, active, ended]);

  // Auto-scroll to the bottom unless the user has scrolled up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    stickyRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
  }, []);

  if (!deploymentId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyHint>Not deployed for this stage.</EmptyHint>
      </div>
    );
  }

  return (
    <ScrollArea
      className="h-full bg-zinc-50"
      viewportRef={scrollerRef}
      onViewportScroll={onScroll}
    >
      <div className="px-4 py-3 font-mono text-xs leading-relaxed text-zinc-800">
        {lines.length === 0 && !error ? (
          <div className="text-muted-foreground">Waiting for logs…</div>
        ) : (
          lines.map((entry, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-words',
                entry.stream === 'stderr' && 'text-red-700',
              )}
            >
              {entry.line}
            </div>
          ))
        )}
        {error && <div className="mt-2 text-amber-700">{error}</div>}
        {ended && (
          <div className="mt-2 text-muted-foreground">[stream ended]</div>
        )}
      </div>
    </ScrollArea>
  );
}
