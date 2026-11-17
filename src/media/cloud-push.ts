import { readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { QueryResult } from 'pg';
import type { CloudStore } from './cloud';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

export interface PushOptions {
  /** Plate crops and keyframes under recognition/ (small, many files). */
  evidence: boolean;
  /** Uploaded videos and images under media/ (large). */
  media: boolean;
  /** Delete the local copy once the bucket holds the same bytes. */
  freeLocal: boolean;
  /** Only results/uploads at least this many days old. */
  olderThanDays: number;
  dryRun: boolean;
  concurrency: number;
  /** Stop uploading before the bucket (under the prefix) holds more than this many GB. */
  maxGb?: number;
}

export interface PushSummary {
  uploaded: number;
  uploadedBytes: number;
  alreadyThere: number;
  freed: number;
  freedBytes: number;
  /** Local copies kept although asked to free them (e.g. a camera replays the video). */
  kept: number;
  /** Files left local because uploading them would pass maxGb. */
  overLimit: number;
  /** Bytes in the bucket (under the prefix) after the run. */
  bucketBytes: number;
  failed: number;
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg']);
const DAY = 24 * 3600 * 1000;

async function files(folder: string, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await files(file, root)));
    else if (entry.isFile()) out.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Copy finished evidence and/or uploads to the bucket, skipping what is already there, and
 * optionally free the disk. Never touches files of queued/running jobs, live sessions in
 * progress, or (for freeing) videos a camera replays, since those must stay on the disk.
 */
export async function cloudPush(
  db: Queryable,
  dataDir: string,
  store: CloudStore,
  options: PushOptions,
  log: (line: string) => void = console.log,
): Promise<PushSummary> {
  const summary: PushSummary = {
    uploaded: 0,
    uploadedBytes: 0,
    alreadyThere: 0,
    freed: 0,
    freedBytes: 0,
    kept: 0,
    overLimit: 0,
    bucketBytes: 0,
    failed: 0,
  };
  const cutoff = new Date(Date.now() - options.olderThanDays * DAY);
  const work: { key: string; free: boolean }[] = [];
  const remote = new Map<string, number>();

  if (options.evidence) {
    const jobs = (
      await db.query(
        `SELECT id FROM recognition_jobs
        WHERE status IN ('succeeded','failed') AND coalesce(finished_at, created_at) <= $1
        ORDER BY coalesce(finished_at, created_at), id`,
        [cutoff],
      )
    ).rows.map((row) => row.id as string);
    const folders = new Set(
      await readdir(path.join(dataDir, 'recognition')).catch(() => [] as string[]),
    );
    for (const id of jobs)
      if (folders.has(id))
        for (const key of await files(path.join(dataDir, 'recognition', id), dataDir))
          if (IMAGE.has(path.extname(key).toLowerCase()))
            work.push({ key, free: options.freeLocal });
  }
  if (options.media) {
    const media = (
      await db.query(
        `SELECT m.storage_key,
          EXISTS (SELECT 1 FROM stream_sources c WHERE c.media_id=m.id) AS replayed,
          EXISTS (SELECT 1 FROM recognition_jobs j WHERE j.media_id=m.id
            AND j.status IN ('queued','running')) AS busy
        FROM media_assets m WHERE m.uploaded_at <= $1 ORDER BY m.uploaded_at, m.id`,
        [cutoff],
      )
    ).rows;
    for (const row of media) {
      if (row.busy) continue;
      if (!(await stat(path.join(dataDir, row.storage_key)).catch(() => null))?.isFile()) continue;
      if (options.freeLocal && row.replayed) summary.kept++;
      work.push({ key: row.storage_key, free: options.freeLocal && !row.replayed });
    }
  }
  for (const prefix of ['recognition/', 'media/'])
    for await (const object of store.list(prefix)) remote.set(object.key, object.size);
  let bucket = [...remote.values()].reduce((sum, size) => sum + size, 0);
  const cap = options.maxGb === undefined ? Infinity : options.maxGb * 1024 ** 3;

  // Plan oldest first: what is already there, what fits under the cap, what stays local.
  const plan: { key: string; size: number; upload: boolean; free: boolean }[] = [];
  for (const item of work) {
    const size = (await stat(path.join(dataDir, item.key)).catch(() => null))?.size;
    if (size === undefined) continue;
    if (remote.get(item.key) === size) {
      summary.alreadyThere++;
      plan.push({ ...item, size, upload: false });
    } else if (bucket - (remote.get(item.key) ?? 0) + size > cap) {
      summary.overLimit++;
    } else {
      bucket += size - (remote.get(item.key) ?? 0);
      plan.push({ ...item, size, upload: true });
    }
  }
  summary.bucketBytes = bucket;
  const uploads = plan.filter((item) => item.upload).length;
  log(
    `${store.label}${options.dryRun ? ' (dry run)' : ''}: ${uploads} to upload, ` +
      `${summary.alreadyThere} already there, ${summary.overLimit} over the --max-gb limit.`,
  );
  let next = 0,
    done = 0,
    reported = 0;
  const one = async ({ key, size, upload, free }: (typeof plan)[number]) => {
    const file = path.join(dataDir, key);
    if (upload && !options.dryRun) {
      await store.put(key, file);
      if ((await store.head(key)) !== size) throw new Error(`size differs after upload: ${key}`);
    }
    if (upload) {
      summary.uploaded++;
      summary.uploadedBytes += size;
    }
    if (free) {
      if (!options.dryRun) await rm(file);
      summary.freed++;
      summary.freedBytes += size;
    }
  };
  const lane = async () => {
    while (next < plan.length) {
      const item = plan[next++];
      try {
        await one(item);
      } catch (error) {
        summary.failed++;
        log(`  failed ${item.key}: ${error instanceof Error ? error.message : error}`);
      }
      const percent = Math.floor((++done * 10) / plan.length) * 10;
      if (percent > reported) {
        reported = percent;
        log(`  ${percent}% (${done}/${plan.length})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, lane));
  return summary;
}
