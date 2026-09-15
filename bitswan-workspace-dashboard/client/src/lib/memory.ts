// The memory chip's two halves, in ONE unit.
//
// `mem_reservation_mb` is called MB everywhere — the wire field, the
// `gitops.mem_reservation_mb` label, the `memory_reservation` key in
// automation.toml — but every consumer treats it as MiB: gitops raises the
// over-reservation flag at `usage_bytes > mb * 1024 * 1024`, and the daemon
// budgets the host by dividing bytes by 1024*1024. The number IS MiB.
//
// Printing "45.5 MiB / 50 MB" therefore invited a comparison between two
// different units — 50 MB is 47.7 MiB — right next to a red flag that fires on
// the MiB reading. Labelling the declared value MiB says what the system
// actually does with it; re-basing it to decimal MB would quietly move every
// reservation, budget and admission decision by 4.9%.

/** Bytes as MiB-based units — the base every memory number here is in. */
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

/** "45.5 MiB / 50 MiB" — live usage over the declared reservation, same unit. */
export function memoryPair(usageBytes?: number, reservationMB?: number): string {
  const used = usageBytes == null ? '—' : fmtMiB(usageBytes);
  return `${used} / ${reservationMB ?? '—'} MiB`;
}
