import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DockerInspect } from '@/types';
import { formatBytes, formatTimestamp, mono, muted, unavailable } from './formatters';

export type Row = [string, ReactNode];

// gitops normally sends a projected `docker inspect` record. A container whose
// inspect call failed degrades to docker's flat `/containers/json` LIST shape
// (`Names: ["/x"]`, `State: "running"`, `Labels` top-level), so every field that
// differs between the two shapes is read through one of these accessors.
// `undefined` from an accessor means "not in the payload" → rendered as
// `unavailable()`, distinct from a value that is genuinely empty.

/** `State` is an object in the inspect shape, a bare status string in the list shape. */
function stateOf(c: DockerInspect) {
  return typeof c.State === 'object' && c.State !== null ? c.State : undefined;
}

function statusOf(c: DockerInspect) {
  if (typeof c.State === 'string') return c.State || undefined;
  return stateOf(c)?.Status || undefined;
}

function isRunning(c: DockerInspect): boolean {
  return stateOf(c)?.Running ?? statusOf(c) === 'running';
}

function nameOf(c: DockerInspect) {
  const n = c.Name ?? c.Names?.[0];
  return n ? n.replace(/^\//, '') : undefined;
}

function labelsOf(c: DockerInspect) {
  return c.Config?.Labels ?? c.Labels;
}

export function identityRows(c: DockerInspect): Row[] {
  const status = statusOf(c);
  const healthy = stateOf(c)?.Health?.Status === 'healthy';
  return [
    ['Container ID', mono(c.Id?.slice(0, 12)) ?? unavailable()],
    ['Name', nameOf(c) ?? unavailable()],
    ['Created', formatTimestamp(c.Created) ?? unavailable()],
    [
      'Status',
      status ? (
        <span className="inline-flex items-center gap-2">
          {status}
          {healthy && (
            <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
              healthy
            </Badge>
          )}
        </span>
      ) : (
        unavailable()
      ),
    ],
    ['Restart count', c.RestartCount ?? unavailable()],
  ];
}

export function imageRows(c: DockerInspect): Row[] {
  // In the inspect shape `Image` is the content digest and `Config.Image` the
  // tag the container was created from; the list shape only carries the tag
  // under `Image`. Split them by prefix so neither row shows the other's value.
  const isDigest = c.Image?.startsWith('sha256:') ?? false;
  const digest = isDigest ? c.Image : undefined;
  const repository = c.Config?.Image ?? (isDigest ? undefined : c.Image);
  const commit = labelsOf(c)?.['gitops.commit'];
  const rows: Row[] = [
    ['Repository', repository ?? unavailable()],
    ['Digest', mono(digest) ?? unavailable()],
  ];
  // Nothing in the deploy path labels containers with a source commit today, so
  // the row would be a permanent dash — omit it rather than imply we lost it.
  if (commit) rows.push(['Commit', mono(commit.slice(0, 12))]);
  rows.push(['Created', formatTimestamp(c.Created) ?? unavailable()]);
  return rows;
}

export function networkRows(c: DockerInspect): Row[] {
  const settings = c.NetworkSettings;
  const firstNet = Object.entries(settings?.Networks ?? {})[0];
  const mode = c.HostConfig?.NetworkMode;
  const running = isRunning(c);
  const ports = settings?.Ports;
  const portStrs = Object.entries(ports ?? {}).map(([key, bindings]) => {
    if (!bindings || bindings.length === 0) return key;
    const hostPort = bindings[0]?.HostPort;
    return hostPort ? `${key} → ${hostPort}` : key;
  });

  // `host`/`none`/`container:<id>` network modes have no entry under
  // `Networks`, so fall back to the mode itself — that IS the answer.
  const network = firstNet?.[0] ?? mode;
  const ip = firstNet?.[1]?.IPAddress;
  const ipFallback = !settings
    ? unavailable()
    : mode === 'host' || mode === 'none'
      ? muted(`${mode} network`)
      : running
        ? muted('none')
        : muted('not running');

  return [
    ['Network', network ?? (settings ? muted('none') : unavailable())],
    ['IP address', mono(ip) ?? ipFallback],
    [
      'Ports',
      portStrs.length > 0
        ? mono(portStrs.join(', '))
        : ports
          ? muted('none published')
          : unavailable(),
    ],
    ['Hostname', mono(c.Config?.Hostname) ?? (c.Config ? muted('none') : unavailable())],
  ];
}

export function resourceRows(c: DockerInspect): Row[] {
  const host = c.HostConfig;
  const pid = stateOf(c)?.Pid;
  return [
    // "unlimited" is only true if we actually read HostConfig — with no
    // HostConfig at all we know nothing about the limits.
    [
      'CPU limit',
      !host
        ? unavailable()
        : host.NanoCpus
          ? `${(host.NanoCpus / 1e9).toFixed(2)} cores`
          : 'unlimited',
    ],
    [
      'Memory limit',
      !host ? unavailable() : host.Memory ? formatBytes(host.Memory) : 'unlimited',
    ],
    // A stopped container reports Pid 0 — that's "no process", not a missing field.
    ['PID', pid ? pid : stateOf(c) ? muted('not running') : unavailable()],
  ];
}

export function mountRows(c: DockerInspect): Row[] {
  const mounts = c.Mounts;
  if (!mounts) return [['Mounts', unavailable()]];
  if (mounts.length === 0) {
    return [['Mounts', muted('none')]];
  }
  return mounts.map((m, i): Row => [
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

export function envRows(c: DockerInspect): Row[] {
  // Values arrive pre-masked from the server (secret values are `****` unless
  // the viewer's role may see them) — this only renders what was sent.
  const env = c.Env ?? [];
  if (env.length === 0) {
    return [['Environment', muted('none')]];
  }
  return env.map((v, i): Row => [
    v.name ?? '?',
    <span key={i} className="inline-flex items-center gap-2">
      {v.masked ? (
        <span className="font-mono text-xs text-muted-foreground">{v.value ?? '****'}</span>
      ) : (
        mono(v.value ?? '')
      )}
      {v.secret && (
        <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-700">
          secret
        </Badge>
      )}
    </span>,
  ]);
}

export function healthRows(c: DockerInspect): Row[] {
  const hc = c.Config?.Healthcheck;
  if (!hc) return [];
  const test = hc.Test ? hc.Test.filter((s) => s !== 'CMD' && s !== 'CMD-SHELL').join(' ') : null;
  const interval = hc.Interval ? `${(hc.Interval / 1e9).toFixed(0)}s` : null;
  const health = stateOf(c)?.Health;
  return [
    ['Test', mono(test) ?? unavailable()],
    ['Interval', interval ?? muted('default')],
    ['Status', health?.Status ?? (isRunning(c) ? unavailable() : muted('not running'))],
    ['Failing streak', health?.FailingStreak ?? 0],
  ];
}
