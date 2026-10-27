import * as path from 'node:path';
import { z } from 'zod';
import { safeStorage } from '../recognition/engine';

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

export type Zone = [number, number, number, number];

/** Readable from this OCR confidence: precision 0.95 on labelled ICPR tracks (docs/EVALUATION.md). */
export const DEFAULT_MIN_CONFIDENCE = 0.96;

/** True for a YouTube watch, live or short link; the live process resolves it with yt-dlp. */
export function isYoutubeUrl(url: string) {
  return z.url().safeParse(url).success && YOUTUBE_HOSTS.includes(new URL(url).hostname);
}

/** True for rtsp:// or rtsps:// with a host: an IP camera the live process opens with ffmpeg. */
export function isRtspUrl(url: string) {
  try {
    const parsed = new URL(url);
    return ['rtsp:', 'rtsps:'].includes(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Hide the password of rtsp://user:password@host URLs. Camera URLs often carry
 * credentials; they must not reach API responses, events or stored error messages.
 */
export function redactUrl(text: string) {
  return text.replace(/(rtsps?:\/\/)([^/@\s:]*):[^/@\s]*@/gi, '$1$2:***@');
}

/** The video id of a watch, youtu.be, live, shorts or embed link; null for channel links. */
export function youtubeVideoId(url: string): string | null {
  let id: string | null | undefined;
  try {
    const parsed = new URL(url);
    id =
      parsed.hostname === 'youtu.be'
        ? parsed.pathname.split('/')[1]
        : (parsed.searchParams.get('v') ??
          parsed.pathname.match(/^\/(?:live|shorts|embed)\/([^/]+)/)?.[1]);
  } catch {
    return null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Live recognition reads five real frames per track, so only joint OCR pipelines qualify. */
export function isLivePipeline(snapshot: Record<string, any>) {
  return snapshot.task === 'recognize' && snapshot.recognizer?.input_mode === 'five_frame_joint';
}

/** Normalized [x1, y1, x2, y2] rectangles; detections centred inside one are ignored. */
export const excludeZones = z
  .array(
    z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .refine(
        ([x1, y1, x2, y2]) => 0 <= x1 && x1 < x2 && x2 <= 1 && 0 <= y1 && y1 < y2 && y2 <= 1,
        {
          message: 'Zones are [x1, y1, x2, y2] with 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1.',
        },
      ),
  )
  .max(16);

/** Where a live process reads from: a YouTube link, an IP camera, or a demo video replayed in a loop. */
export type LiveSource =
  { type: 'youtube'; url: string } | { type: 'rtsp'; url: string } | { type: 'file'; path: string };

/** Payload for `python -m app.live`: the same pinned snapshot a job gets, plus the source. */
export function livePayload(
  snapshot: Record<string, any>,
  source: LiveSource,
  zones: Zone[] = [],
  maxHeight = 1080,
) {
  return {
    pipeline_snapshot: snapshot,
    source:
      source.type === 'file'
        ? // Paced at its frame rate and looped, so it behaves like a camera that never ends.
          { type: 'file', path: source.path, realtime: true, loop: true, exclude_zones: zones }
        : { type: source.type, url: source.url, exclude_zones: zones, max_height: maxHeight },
  };
}

/** Demo cameras replay videos placed under PLATE_DATA_DIR/demo-videos (admins only). */
export const DEMO_VIDEO_DIR = 'demo-videos';
export const DEMO_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];

/** Absolute path of a demo video; throws for keys that leave the demo folder. */
export function demoVideoFile(dataDir: string, key: string) {
  return safeStorage(path.join(dataDir, DEMO_VIDEO_DIR), key);
}

/** Video heights a live session may request; 1080p needs ~4 Mbit/s sustained. */
export const MAX_HEIGHTS = [480, 720, 1080] as const;
