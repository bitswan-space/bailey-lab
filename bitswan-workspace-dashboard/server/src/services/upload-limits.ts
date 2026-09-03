import { promises as fs } from 'node:fs';

const FREE_SPACE_FRACTION = 0.8;

export const BUFFERED_UPLOAD_CEILING_BYTES = 100 * 1024 * 1024;

export const FREE_DISK_REASON = '80% of the free disk space on this workspace';

export const MEMORY_CEILING_REASON =
  'the ceiling for uploads the server has to hold in memory';

export interface UploadLimit {
  maxBytes: number;
  maxBytesLabel: string;
  reason: string;
}

export function formatByteSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

export async function uploadLimitBytes(dir: string): Promise<number> {
  const st = await fs.statfs(dir);
  return Math.floor(Number(st.bavail) * Number(st.bsize) * FREE_SPACE_FRACTION);
}

export function describeLimit(maxBytes: number, reason: string): UploadLimit {
  return { maxBytes, maxBytesLabel: formatByteSize(maxBytes), reason };
}

export async function bufferedUploadLimit(dir: string): Promise<UploadLimit> {
  const onDisk = await uploadLimitBytes(dir);
  return onDisk < BUFFERED_UPLOAD_CEILING_BYTES
    ? describeLimit(onDisk, FREE_DISK_REASON)
    : describeLimit(BUFFERED_UPLOAD_CEILING_BYTES, MEMORY_CEILING_REASON);
}

export function tooLargeMessage(names: string[], limit: UploadLimit): string {
  const tail = names.length === 1 ? 'it' : 'them';
  return (
    `${names.join(', ')} exceeded the ${limit.maxBytesLabel} upload limit ` +
    `(${limit.reason}). Nothing was saved for ${tail}.`
  );
}
