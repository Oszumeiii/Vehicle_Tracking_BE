import { recordMinutes } from './clips';
import { readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Database } from '../database/database';
import { safeStorage, WorkerOptions } from '../recognition/engine';
import { folderBytes, removeFolder } from './files';

export interface RetentionSettings {
  intervalMs: number;
  batch: number;
}

export function retentionSettings(): RetentionSettings {
  const minutes = Number(process.env.PLATE_RETENTION_INTERVAL_MINUTES ?? 10);
  if (!Number.isFinite(minutes) || minutes <= 0)
    throw new Error('PLATE_RETENTION_INTERVAL_MINUTES must be positive');
  return { intervalMs: minutes * 60_000, batch: 200 };
}

const HOUR = 3600_000;
// Kept for context once a live track's other keyframes are pruned (the middle one).
const KEPT_FRAME = 3;
// Tracks a person reviewed, a watchlist alerted on, or that were sampled for
// independent labelling are never pruned or deleted.
const UNPROTECTED = `NOT j.alerted AND a.review_status='pending'
  AND NOT EXISTS (SELECT 1 FROM evaluation_items e WHERE e.job_id=j.id)`;
const LIVE_JOBS = `recognition_jobs j JOIN plate_appearances a ON a.job_id=j.id
  JOIN live_sessions s ON s.id=j.live_session_id JOIN stream_sources c ON c.id=s.stream_source_id`;

/**
 * Live evidence retention, run by the worker. Per camera, keyframes older than
 * keyframe_retention_hours are pruned to one per track (1080p JPEGs are ~80% of the
 * bytes; crops stay), and tracks older than track_retention_days are deleted.
 * Folders left without rows (a crash between moving a track and committing it, a
 * deleted session, the trash) are swept as well.
 */
export class Retention {
  constructor(
    private database: Database,
    private options: WorkerOptions,
    private settings: RetentionSettings = retentionSettings(),
  ) {}

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      await this.sweep().catch((error) => {
        console.error('Retention sweep failed:', error instanceof Error ? error.message : error);
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.settings.intervalMs);
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }

  async sweep() {
    return {
      pruned: await this.pruneKeyframes(),
      deleted: await this.deleteTracks(),
      orphans: await this.sweepOrphans(),
      recordings: await this.sweepRecordings(),
    };
  }

  private async pruneKeyframes() {
    const due = (
      await this.database.query(
        `SELECT j.id FROM ${LIVE_JOBS}
        WHERE j.evidence_pruned_at IS NULL AND c.keyframe_retention_hours IS NOT NULL
          AND j.captured_to < now() - make_interval(hours => c.keyframe_retention_hours) AND ${UNPROTECTED}
        ORDER BY j.captured_to LIMIT $1`,
        [this.settings.batch],
      )
    ).rows;
    let pruned = 0;
    for (const { id } of due) {
      const keys = await this.database.transaction(async (c) => {
        // Re-check under lock: a review or deletion may have happened since the scan.
        const job = (
          await c.query(
            `SELECT j.id FROM recognition_jobs j JOIN plate_appearances a ON a.job_id=j.id
            WHERE j.id=$1 AND j.evidence_pruned_at IS NULL AND ${UNPROTECTED} FOR UPDATE OF j`,
            [id],
          )
        ).rows[0];
        if (!job) return null;
        const frames = (
          await c.query(
            `SELECT d.id, d.frame_storage_key FROM plate_detections d
            JOIN plate_appearances a ON a.id=d.appearance_id
            WHERE a.job_id=$1 AND d.selected_order<>$2 AND d.frame_storage_key IS NOT NULL`,
            [id, KEPT_FRAME],
          )
        ).rows;
        await c.query('UPDATE plate_detections SET frame_storage_key=NULL WHERE id=ANY($1)', [
          frames.map((frame) => frame.id),
        ]);
        await c.query('UPDATE recognition_jobs SET evidence_pruned_at=now() WHERE id=$1', [id]);
        return frames.map((frame) => frame.frame_storage_key as string);
      });
      if (!keys) continue;
      const kept = (
        await this.database.query(
          `SELECT d.frame_storage_key FROM plate_detections d JOIN plate_appearances a ON a.id=d.appearance_id
          WHERE a.job_id=$1 AND d.frame_storage_key IS NOT NULL`,
          [id],
        )
      ).rows.map((row) => row.frame_storage_key);
      for (const key of keys)
        if (!kept.includes(key))
          await rm(safeStorage(this.options.dataDir, key), { force: true }).catch(() => {});
      await this.database.query('UPDATE recognition_jobs SET evidence_bytes=$2 WHERE id=$1', [
        id,
        await folderBytes(safeStorage(this.options.dataDir, `recognition/${id}`)),
      ]);
      pruned++;
    }
    return pruned;
  }

  private async deleteTracks() {
    const deleted = (
      await this.database.query(
        `DELETE FROM recognition_jobs WHERE id IN (
          SELECT j.id FROM ${LIVE_JOBS}
          WHERE c.track_retention_days IS NOT NULL
            AND j.captured_to < now() - make_interval(days => c.track_retention_days) AND ${UNPROTECTED}
          ORDER BY j.captured_to LIMIT $1)
        RETURNING id`,
        [this.settings.batch],
      )
    ).rows;
    for (const { id } of deleted)
      await removeFolder(safeStorage(this.options.dataDir, `recognition/${id}`));
    return deleted.length;
  }

  /**
   * Rolling recordings (live/{session}/record/eNNN) whose index has not changed for the
   * kept time: the live process prunes its running epoch itself. Cut videos are a cache
   * kept for an hour (live/recording-cache is not a session, so sweepOrphans removes it).
   */
  private async sweepRecordings() {
    let removed = 0;
    const keepMs = recordMinutes() * 60_000;
    const live = safeStorage(this.options.dataDir, 'live');
    for (const session of await readdir(live).catch(() => [] as string[])) {
      const record = path.join(live, session, 'record');
      for (const epoch of await readdir(record).catch(() => [] as string[])) {
        const index = await stat(path.join(record, epoch, 'index.jsonl')).catch(() => null);
        const folder = await stat(path.join(record, epoch)).catch(() => null);
        const changed = index?.mtimeMs ?? folder?.mtimeMs ?? Date.now();
        if (Date.now() - changed > keepMs) {
          await removeFolder(path.join(record, epoch));
          removed++;
        }
      }
      const cache = path.join(live, session, 'cache');
      for (const name of await readdir(cache).catch(() => [] as string[])) {
        const info = await stat(path.join(cache, name)).catch(() => null);
        if (info && Date.now() - info.mtimeMs > HOUR) {
          await rm(path.join(cache, name), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private async sweepOrphans() {
    let removed = 0;
    const old = async (folder: string, ageMs: number) => {
      const info = await stat(folder).catch(() => null);
      return info !== null && Date.now() - info.mtimeMs > ageMs;
    };
    const recognition = safeStorage(this.options.dataDir, 'recognition');
    const jobs = await readdir(recognition).catch(() => [] as string[]);
    for (let i = 0; i < jobs.length; i += 500) {
      const names = jobs.slice(i, i + 500);
      const known = new Set(
        (
          await this.database.query('SELECT id FROM recognition_jobs WHERE id=ANY($1)', [names])
        ).rows.map((row) => row.id),
      );
      for (const name of names)
        if (!known.has(name) && (await old(path.join(recognition, name), HOUR))) {
          await removeFolder(path.join(recognition, name));
          removed++;
        }
    }
    const live = safeStorage(this.options.dataDir, 'live');
    const sessions = await readdir(live).catch(() => [] as string[]);
    const existing = new Set(
      sessions.length
        ? (
            await this.database.query('SELECT id FROM live_sessions WHERE id=ANY($1)', [sessions])
          ).rows.map((row) => row.id)
        : [],
    );
    for (const name of sessions)
      if (!existing.has(name) && (await old(path.join(live, name), HOUR))) {
        await removeFolder(path.join(live, name));
        removed++;
      }
    const trash = safeStorage(this.options.dataDir, 'trash');
    for (const name of await readdir(trash).catch(() => [] as string[]))
      if (await old(path.join(trash, name), 24 * HOUR)) {
        await removeFolder(path.join(trash, name));
        removed++;
      }
    return removed;
  }
}
