export function formatTimestamp(s: string | undefined | null): string | null {
  if (!s) return null;
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function mono(s: string | undefined | null) {
  return s ? <span className="font-mono">{s}</span> : null;
}
