import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { QueryResult } from 'pg';
import { Database } from '../database/database';
import {
  persistAppearance,
  safeStorage,
  validateResult,
  WorkerOptions,
} from '../recognition/engine';
import { levenshtein } from '../recognition/fusion';
import type { AlertPayload } from '../notify/message';
import { enqueueDeliveries, wakeAlertNotifier } from '../notify/notifier';
import { priorityRank } from '../notify/settings';
import { folderBytes, moveFolder } from './files';

export { moveFolder };
import { recordEvent } from './sessions';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

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

/**
 * Watchlist entries matching a plate read on a camera, exact or one character off for
 * plates of 5+, each with the users its alert goes to. Personal entries: those of the
 * camera owner and of admins (who see every camera), alerting their owner. Shared
 * entries (made by admins): everyone who sees the camera, i.e. its owner and the admins.
 * Expired entries and inactive users never alert.
 */
async function watchlistMatches(c: Queryable, sourceId: string, plate: string) {
  const owner = (await c.query('SELECT owner_id FROM stream_sources WHERE id=$1', [sourceId]))
    .rows[0]?.owner_id;
  const entries = (
    await c.query(
      `SELECT w.* FROM plate_watchlist w JOIN users u ON u.id=w.owner_id
      WHERE u.is_active AND (w.expires_at IS NULL OR w.expires_at > now())
        AND (w.shared OR u.role='admin' OR w.owner_id=$1)
      ORDER BY w.created_at, w.id`,
      [owner],
    )
  ).rows;
  const matches = entries
    .map((entry) => ({ ...entry, distance: levenshtein(entry.plate, plate) }))
    .filter(
      (entry) =>
        entry.distance === 0 ||
        (entry.distance === 1 && Math.min(entry.plate.length, plate.length) >= 5),
    );
  const viewers = matches.some((entry) => entry.shared)
    ? (
        await c.query(
          "SELECT id FROM users WHERE is_active AND (role='admin' OR id=$1) ORDER BY id",
          [owner],
        )
      ).rows.map((row) => row.id as string)
    : [];
  return matches.map((entry) => ({
    ...entry,
    recipients: entry.shared ? viewers : [entry.owner_id as string],
  }));
}

type Match = Awaited<ReturnType<typeof watchlistMatches>>[number];

/** The match a recipient is told about: the closest plate, then the most urgent entry. */
function better(candidate: Match, current: Match | undefined) {
  return (
    !current ||
    candidate.distance < current.distance ||
    (candidate.distance === current.distance &&
      priorityRank(candidate.priority) > priorityRank(current.priority))
  );
}

function sightingMinutes() {
  const value = Number(process.env.PLATE_LIVE_SIGHTING_MINUTES ?? 5);
  if (!Number.isFinite(value) || value < 0)
    throw new Error('PLATE_LIVE_SIGHTING_MINUTES must be >= 0');
  return value;
}

/**
 * The sighting (passage of one vehicle) a new track belongs to: an earlier track on
 * the same camera, across sessions, that ended at most PLATE_LIVE_SIGHTING_MINUTES
 * before it and read the same plate (or one character off for plates of 5+). A
 * duplicate of an earlier track joins its sighting. Otherwise it starts its own.
 */
async function sightingOf(
  c: Queryable,
  sourceId: string,
  text: string | null,
  capturedFrom: string,
  duplicate: string | null,
) {
  if (duplicate)
    return (
      (await c.query('SELECT sighting_id FROM recognition_jobs WHERE id=$1', [duplicate])).rows[0]
        ?.sighting_id ?? null
    );
  if (!text) return null;
  const recent = (
    await c.query(
      `SELECT j.sighting_id, a.machine_text FROM recognition_jobs j
      JOIN live_sessions s ON s.id=j.live_session_id JOIN plate_appearances a ON a.job_id=j.id
      WHERE s.stream_source_id=$1 AND a.machine_text IS NOT NULL AND j.sighting_id IS NOT NULL
        AND j.captured_to BETWEEN $2::timestamptz - make_interval(secs => $3) AND $2::timestamptz
      ORDER BY j.captured_to DESC LIMIT 100`,
      [sourceId, capturedFrom, sightingMinutes() * 60],
    )
  ).rows;
  const match = recent.find((row) => {
    const distance = levenshtein(row.machine_text, text);
    return (
      distance === 0 || (distance === 1 && Math.min(row.machine_text.length, text.length) >= 5)
    );
  });
  return match?.sighting_id ?? null;
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
    !(record.duplicate_of === null || TRACK_KEY.test(record.duplicate_of)) ||
    !(
      record.capture_clock === undefined ||
      ['stream', 'received', 'recorded'].includes(record.capture_clock)
    )
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
  await moveFolder(source, target);
  let queued = 0;
  try {
    await validateResult(job, { appearances: [appearance], statistics: {} }, target, options);
    const bytes = await folderBytes(target);
    await database.transaction(async (c) => {
      const duplicate = record.duplicate_of
        ? ((
            await c.query(
              'SELECT id FROM recognition_jobs WHERE live_session_id=$1 AND live_track_key=$2',
              [session.id, record.duplicate_of],
            )
          ).rows[0]?.id ?? null)
        : null;
      const text: string | null = appearance.machine_text;
      const sighting =
        (await sightingOf(c, session.stream_source_id, text, capturedFrom, duplicate)) ?? jobId;
      const matches = text ? await watchlistMatches(c, session.stream_source_id, text) : [];
      await c.query(
        `INSERT INTO recognition_jobs
        (id,live_session_id,live_track_key,job_kind,input_mode,pipeline_snapshot,status,stage,statistics,
         started_at,finished_at,captured_from,captured_to,confidence_status,duplicate_of_job_id,
         sighting_id,alerted,evidence_bytes)
        VALUES ($1,$2,$3,'recognize','scene',$4,'succeeded','complete',$5,now(),now(),$6,$7,$8,$9,$10,$11,$12)`,
        [
          jobId,
          session.id,
          key,
          JSON.stringify(session.pipeline_snapshot),
          JSON.stringify({
            epoch: record.epoch,
            observations: record.observations,
            confidence: record.confidence,
            capture_clock: record.capture_clock ?? 'received',
            // Below 1 when the session shared the GPU and sampled fewer frames.
            sampling_scale: Number.isFinite(record.sampling_scale) ? record.sampling_scale : 1,
          }),
          capturedFrom,
          capturedTo,
          record.status,
          duplicate,
          sighting,
          matches.length > 0,
          bytes,
        ],
      );
      const { appearanceId, detectionIds } = await persistAppearance(c, job, appearance);
      await c.query('UPDATE live_sessions SET tracks_count=tracks_count+1 WHERE id=$1', [
        session.id,
      ]);
      await recordEvent(c, session.id, 'track', {
        job_id: jobId,
        result_id: appearanceId,
        track: key,
        text,
        confidence_status: record.status,
        confidence: record.confidence,
        captured_from: capturedFrom,
        captured_to: capturedTo,
        duplicate_of_job_id: duplicate,
        sighting_id: sighting,
        capture_clock: record.capture_clock ?? 'received',
        detection_ids: detectionIds,
      });
      // An alert event per entry and recipient (owner_id: who may see it on the event stream).
      const told = new Map<string, Match>();
      for (const match of matches)
        for (const recipient of match.recipients) {
          await recordEvent(c, session.id, 'alert', {
            watchlist_id: match.id,
            watch_plate: match.plate,
            owner_id: recipient,
            watchlist_owner_id: match.owner_id,
            shared: match.shared,
            priority: match.priority,
            reason: match.reason,
            note: match.note,
            plate: text!,
            distance: match.distance,
            job_id: jobId,
            result_id: appearanceId,
            stream_source_id: session.stream_source_id,
            confidence_status: record.status,
            captured_from: capturedFrom,
          });
          if (better(match, told.get(recipient))) told.set(recipient, match);
        }
      // One message per passage: a later track of a sighting that already alerted (a car
      // queued or parked in view is tracked again every max_track_seconds) only shows in the app.
      const repeat =
        sighting !== jobId &&
        (
          await c.query(
            'SELECT 1 FROM recognition_jobs WHERE sighting_id=$1 AND alerted AND id<>$2 LIMIT 1',
            [sighting, jobId],
          )
        ).rows.length > 0;
      if (told.size && !repeat)
        queued = await enqueueDeliveries(
          c,
          await alertPayloads(c, told, {
            plate: text!,
            camera: session.stream_source_id,
            capturedFrom,
            status: record.status,
            confidence: record.confidence,
            jobId,
            appearanceId,
            sessionId: session.id,
          }),
          jobId,
        );
    });
  } catch (error) {
    await moveFolder(target, source).catch(() => {});
    throw error;
  }
  if (queued) wakeAlertNotifier();
  return jobId;
}

/** What each recipient's messages say (one per recipient: its best match). */
async function alertPayloads(
  c: Queryable,
  told: Map<string, Match>,
  read: {
    plate: string;
    camera: string;
    capturedFrom: string;
    status: string;
    confidence: number | null;
    jobId: string;
    appearanceId: string;
    sessionId: string;
  },
) {
  const camera = (
    await c.query('SELECT id, name, latitude, longitude FROM stream_sources WHERE id=$1', [
      read.camera,
    ])
  ).rows[0];
  // The middle crop's frame is the one retention keeps.
  const picture = (
    await c.query(
      `SELECT frame_storage_key, crop_storage_key FROM plate_detections WHERE appearance_id=$1
      ORDER BY (selected_order=3) DESC, selected_order LIMIT 1`,
      [read.appearanceId],
    )
  ).rows[0];
  const payloads = new Map<string, AlertPayload>();
  for (const [recipient, match] of told)
    payloads.set(recipient, {
      kind: 'alert',
      plate: read.plate,
      watch_plate: match.plate,
      distance: match.distance,
      priority: match.priority,
      reason: match.reason,
      note: match.note,
      shared: match.shared,
      camera: camera && {
        id: camera.id,
        name: camera.name,
        latitude: camera.latitude,
        longitude: camera.longitude,
      },
      captured_from: read.capturedFrom,
      confidence_status: read.status,
      confidence: read.confidence,
      job_id: read.jobId,
      result_id: read.appearanceId,
      session_id: read.sessionId,
      image: picture?.frame_storage_key ?? null,
      crop: picture?.crop_storage_key ?? null,
    });
  return payloads;
}
