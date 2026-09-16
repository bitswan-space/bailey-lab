
export function fmtMiB(n: number): string {
  if (!n && n !== 0) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${u[i]}`;
}

export function memoryPair(usageBytes?: number, reservationMB?: number): string {
  const used = usageBytes == null ? '—' : fmtMiB(usageBytes);
  return `${used} / ${reservationMB ?? '—'} MiB`;
}
