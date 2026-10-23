import { z } from 'zod';

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

export type Zone = [number, number, number, number];

/** True for a YouTube watch, live or short link; the live process resolves it with yt-dlp. */
export function isYoutubeUrl(url: string) {
  return z.url().safeParse(url).success && YOUTUBE_HOSTS.includes(new URL(url).hostname);
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

/** Payload for `python -m app.live`: the same pinned snapshot a job gets, plus the source. */
export function livePayload(snapshot: Record<string, any>, url: string, zones: Zone[] = []) {
  return {
    pipeline_snapshot: snapshot,
    source: { type: 'youtube', url, exclude_zones: zones },
  };
}
