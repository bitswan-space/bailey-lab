export type TouchKind = 'get' | 'call' | 'construct';

export interface Touch {
  path: string;
  kind: TouchKind;
  seq: number;
  implemented: boolean;
}

const touches: Touch[] = [];
let seq = 0;

export function recordTouch(path: string, kind: TouchKind, implemented: boolean): void {
  seq += 1;
  touches.push({ path, kind, seq, implemented });
}

export function takeTouches(): Touch[] {
  return touches.slice();
}

export function touchReport(): string {
  const byPath = new Map<string, { kind: TouchKind; count: number; implemented: boolean; first: number }>();
  for (const t of touches) {
    const prev = byPath.get(t.path);
    if (prev) {
      prev.count += 1;
      continue;
    }
    byPath.set(t.path, { kind: t.kind, count: 1, implemented: t.implemented, first: t.seq });
  }
  const rows = [...byPath.entries()].sort((a, b) => a[1].first - b[1].first);
  const missing = rows.filter(([, r]) => !r.implemented);
  const lines: string[] = [];
  lines.push(`touched ${rows.length} distinct vscode paths (${missing.length} unimplemented)`);
  lines.push('');
  lines.push('order  impl  count  path');
  for (const [path, r] of rows) {
    lines.push(
      `${String(r.first).padStart(5)}  ${r.implemented ? ' ok ' : 'MISS'}  ${String(r.count).padStart(5)}  ${path}`,
    );
  }
  return lines.join('\n');
}
