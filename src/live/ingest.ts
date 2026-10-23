import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { Database } from '../database/database';
import {
  persistAppearance,
  safeStorage,
  validateResult,
  WorkerOptions,
} from '../recognition/engine';

type Row = Record<string, any>;
const TRACK_KEY = /^e\d{3}-t\d{6}$/;
const STATUSES = ['readable', 'low_confidence', 'unreadable'];

function rekey(value: any, from: string, to: string): any {
  if (typeof value === 'string')
    return value.startsWith(from) ? to + value.slice(from.length) : value;
  if (Array.isArray(value)) return value.map((item) => rekey(item, from, to));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rekey(v, from, to)]));
  return value;
}

function instant(value: any) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !value.endsWith('Z'))
    throw new Error('Invalid capture time');
  return value;
}

/**
 * Turn one finished live track into a succeeded recognition job of its session.
 *
 * The live process wrote the track under live/{session}/tracks/{key}/. The folder
 * moves to recognition/{job}/ (one folder per job, like uploads), so deletion and
 * evidence checks are unchanged; storage keys are rewritten to match.
 */
export async function ingestTrack(
  database: Database,
  options: WorkerOptions,
  session: Row,
  key: string,
): Promise<string> {
  if (!TRACK_KEY.test(key)) throw new Error('Invalid track key');
  const sourceKey = `live/${session.id}/tracks/${key}`;
  const source = safeStorage(options.dataDir, sourceKey);
  const record = JSON.parse(await readFile(path.join(source, 'track.json'), 'utf8'));
  if (
    record.track !== key ||
    !STATUSES.includes(record.status) ||
    !(
      record.confidence === null ||
      (Number.isFinite(record.confidence) && record.confidence >= 0)
    ) ||
    !(record.duplicate_of === null || TRACK_KEY.test(record.duplicate_of))
  )
    throw new Error('Invalid live track record');
  const capturedFrom = instant(record.captured_from);
  const capturedTo = instant(record.captured_to);
  if (Date.parse(capturedTo) < Date.parse(capturedFrom))
    throw new Error('Invalid capture interval');
  const jobId = randomUUID().replace(/-/g, '');
  const targetKey = `recognition/${jobId}`;
  const target = safeStorage(options.dataDir, targetKey);
  const appearance = rekey(record.appearance, `${sourceKey}/`, `${targetKey}/`);
  const job = {
    id: jobId,
    job_kind: 'recognize',
    input_mode: 'scene',
    media_type: 'video',
    pipeline_snapshot: session.pipeline_snapshot,
    live_session_id: session.id,
  };
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  try {
    await validateResult(job, { appearances: [appearance], statistics: {} }, target, options);
    await database.transaction(async (c) => {
      const duplicate = record.duplicate_of
        ? ((
            await c.query(
              'SELECT id FROM recognition_jobs WHERE live_session_id=$1 AND live_track_key=$2',
              [session.id, record.duplicate_of],
            )
          ).rows[0]?.id ?? null)
        : null;
      await c.query(
        `INSERT INTO recognition_jobs
        (id,live_session_id,live_track_key,job_kind,input_mode,pipeline_snapshot,status,stage,statistics,
         started_at,finished_at,captured_from,captured_to,confidence_status,duplicate_of_job_id)
        VALUES ($1,$2,$3,'recognize','scene',$4,'succeeded','complete',$5,now(),now(),$6,$7,$8,$9)`,
        [
          jobId,
          session.id,
          key,
          JSON.stringify(session.pipeline_snapshot),
          JSON.stringify({
            epoch: record.epoch,
            observations: record.observations,
            confidence: record.confidence,
          }),
          capturedFrom,
          capturedTo,
          record.status,
          duplicate,
        ],
      );
      await persistAppearance(c, job, appearance);
      await c.query('UPDATE live_sessions SET tracks_count=tracks_count+1 WHERE id=$1', [
        session.id,
      ]);
    });
  } catch (error) {
    await rename(target, source).catch(() => {});
    throw error;
  }
  return jobId;
}
