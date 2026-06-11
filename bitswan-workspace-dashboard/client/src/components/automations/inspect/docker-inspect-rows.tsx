import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DockerInspect } from '@/types';
import { formatBytes, formatTimestamp, mono } from './formatters';

export type Row = [string, ReactNode];

export function identityRows(c: DockerInspect): Row[] {
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

export function imageRows(c: DockerInspect): Row[] {
  const commit = c.Config?.Labels?.['gitops.commit'];
  return [
    ['Repository', c.Config?.Image ?? null],
    ['Digest', mono(c.Image)],
    ['Commit', mono(commit ? commit.slice(0, 12) : undefined)],
    ['Created', formatTimestamp(c.Created)],
  ];
}

export function networkRows(c: DockerInspect): Row[] {
  const networks = c.NetworkSettings?.Networks ?? {};
  const firstNet = Object.entries(networks)[0];
  const portStrs = Object.entries(c.NetworkSettings?.Ports ?? {}).map(([key, bindings]) => {
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

export function resourceRows(c: DockerInspect): Row[] {
  const cpus = c.HostConfig?.NanoCpus;
  const mem = c.HostConfig?.Memory;
  return [
    ['CPU limit', cpus ? `${(cpus / 1e9).toFixed(2)} cores` : 'unlimited'],
    ['Memory limit', mem ? formatBytes(mem) : 'unlimited'],
    ['PID', c.State?.Pid ?? null],
  ];
}

export function mountRows(c: DockerInspect): Row[] {
  const mounts = c.Mounts ?? [];
  if (mounts.length === 0) {
    return [['Mounts', <span key="m" className="text-muted-foreground">none</span>]];
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

export function healthRows(c: DockerInspect): Row[] {
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
