import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Database } from '../database/database';
import { pythonEnv, safeStorage, WorkerOptions } from '../recognition/engine';

type Row = Record<string, any>;
const TRACK_KEY = /^e\d{3}-t\d{6}$/;

/** How long the rolling recording of a camera is kept (worker and API agree through the env). */
export function recordMinutes(value = process.env.PLATE_LIVE_RECORD_MINUTES ?? '240') {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60)
    throw new Error('PLATE_LIVE_RECORD_MINUTES must be a number from 1 to 10080');
  return minutes;
}

/**
 * Move a clip the live process cut (live/{session}/clips/{track}.mp4) next to its job's
 * evidence (recognition/{job}/clip.mp4). A clip of a track that never became a job is dropped.
 */
export async function attachClip(
  database: Database,
  options: WorkerOptions,
  session: Row,
  key: string,
  clip: string,
  firstSeenOffset = 0,
) {
  if (!TRACK_KEY.test(key) || clip !== `clips/${key}.mp4`) throw new Error('Invalid clip event');
  const source = safeStorage(options.dataDir, `live/${session.id}/${clip}`);
  const job = (
    await database.query(
      'SELECT id FROM recognition_jobs WHERE live_session_id=$1 AND live_track_key=$2',
      [session.id, key],
    )
  ).rows[0];
  if (!job) {
    await rm(source, { force: true });
    return null;
  }
  const targetKey = `recognition/${job.id}/clip.mp4`;
  const target = safeStorage(options.dataDir, targetKey);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  const { size } = await stat(target);
  await database.query(
    `UPDATE recognition_jobs SET clip_storage_key=$2, evidence_bytes=coalesce(evidence_bytes,0)+$3,
       statistics=statistics || jsonb_build_object('clip_first_seen_offset', $4::float8)
     WHERE id=$1`,
    [job.id, targetKey, size, Number.isFinite(firstSeenOffset) ? firstSeenOffset : 0],
  );
  return job.id as string;
}

/** index.jsonl files of the rolling recordings of these sessions (one per connection epoch). */
export async function recordingIndexes(dataDir: string, sessions: string[]) {
  const files: string[] = [];
  for (const session of sessions) {
    const folder = safeStorage(dataDir, `live/${session}/record`);
    const epochs = await readdir(folder).catch(() => [] as string[]);
    for (const epoch of epochs.filter((name) => /^e\d{3}$/.test(name)).sort())
      files.push(path.join(folder, epoch, 'index.jsonl'));
  }
  return files;
}

export interface Interval {
  from: string;
  to: string;
}

/** Recorded wall-clock intervals of the given index files, merged where they touch (<= 1 s apart). */
export async function coverage(files: string[]): Promise<Interval[]> {
  const spans: [number, number][] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line);
        spans.push([Date.parse(entry.utc_start), Date.parse(entry.utc_end)]);
      } catch {
        /* a blank or partial line */
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)))
    if (merged.length && from - merged[merged.length - 1][1] <= 1000)
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], to);
    else merged.push([from, to]);
  return merged.map(([from, to]) => ({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  }));
}

export class NotRecorded extends Error {}

let cutting = 0;
const waiting: (() => void)[] = [];

/**
 * Cut [from, to] (ISO times) out of the recordings into out with `python -m app.live.clips`
 * (stream copy). At most two cuts run at once; each is given 60 s.
 */
export async function cutRecording(
  options: Pick<WorkerOptions, 'python'>,
  files: string[],
  from: string,
  to: string,
  out: string,
): Promise<{ first_seen_offset: number; seconds: number }> {
  if (!files.length) throw new NotRecorded('No recording');
  while (cutting >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  cutting++;
  try {
    await mkdir(path.dirname(out), { recursive: true });
    const child = spawn(
      options.python,
      ['-m', 'app.live.clips', '--index', ...files, '--from', from, '--to', to, '--out', out],
      { cwd: process.cwd(), windowsHide: true, env: pythonEnv() },
    );
    let stdout = '';
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.resume();
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    if (code === 2) throw new NotRecorded('This time is not recorded');
    if (code !== 0) throw new Error('Cutting the recording failed');
    return JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
  } finally {
    cutting--;
    waiting.shift()?.();
  }
}
