import { statfs } from 'node:fs/promises';

/** Free space the data folder must keep (PLATE_MIN_FREE_GB, default 5; 0 disables the guard). */
export function minFreeBytes() {
  const value = Number(process.env.PLATE_MIN_FREE_GB ?? 5);
  if (!Number.isFinite(value) || value < 0) throw new Error('PLATE_MIN_FREE_GB must be >= 0');
  return Math.round(value * 2 ** 30);
}

/** Free and total bytes of the disk holding `dir`. */
export async function diskSpace(dir: string) {
  const s = await statfs(dir);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
}

/**
 * Whether the disk of `dir` is below the free-space floor. Live sessions stop, new ones wait
 * and uploads are refused until space is freed (retention, deleting data), so evidence and
 * the database never fill the disk. An unreadable disk counts as fine (no false stop).
 */
export async function diskLow(dir: string) {
  const floor = minFreeBytes();
  if (!floor) return { low: false, free: null as number | null, floor };
  const space = await diskSpace(dir).catch(() => null);
  return { low: space !== null && space.free < floor, free: space?.free ?? null, floor };
}
