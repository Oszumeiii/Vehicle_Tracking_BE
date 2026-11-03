import { stat } from 'node:fs/promises';
import type { QueryResult } from 'pg';
import { safeStorage } from '../recognition/engine';
import { demoVideoFile } from './payload';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

/** Cameras whose source is a video file played back as if live. */
export const REPLAY_TYPES = ['file', 'media'];
export const isReplay = (camera: { source_type?: string } | undefined | null) =>
  REPLAY_TYPES.includes(camera?.source_type ?? '');

/**
 * The file a replay camera plays and how: a demo camera loops a video under demo-videos; an
 * upload camera plays the user's uploaded video once (or loops if asked), and when it plays
 * once and the video says when it was filmed, track times follow that clock (recorded_at).
 * Null for other cameras or a file that is gone.
 */
export async function replaySource(
  db: Queryable,
  dataDir: string,
  camera: Record<string, any>,
): Promise<{ path: string; loop: boolean; recordedAt: Date | null } | null> {
  let path: string,
    loop: boolean,
    recordedAt: Date | null = null;
  try {
    if (camera.source_type === 'file') {
      path = demoVideoFile(dataDir, camera.url);
      loop = true;
    } else if (camera.source_type === 'media') {
      const media = (
        await db.query('SELECT storage_key, recorded_at FROM media_assets WHERE id=$1', [
          camera.media_id,
        ])
      ).rows[0];
      if (!media) return null;
      path = safeStorage(dataDir, media.storage_key);
      loop = Boolean(camera.replay_loop);
      recordedAt = loop ? null : (media.recorded_at ?? null);
    } else return null;
  } catch {
    return null;
  }
  return (await stat(path).catch(() => null))?.isFile() ? { path, loop, recordedAt } : null;
}
