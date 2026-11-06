import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { AuthGuard } from '../auth/auth.guard';
import { settings } from '../common/config';
import { Actor } from '../common/http';
import { ApiFailures, ApiFileResponse, ApiRangedFileResponse } from '../common/openapi';
import { Ownership } from '../common/ownership';
import { Database } from '../database/database';
import { safeStorage } from '../recognition/engine';
import { remuxSegment } from './clips';
import { youtubeVideoId } from './payload';
import { isReplay, replaySource } from './replay';
import { ACTIVE_STATUSES } from './sessions';

type Row = Record<string, any>;
/** Closed segments listed in the live playlist (10 s each). */
const PLAYLIST_SEGMENTS = 6;
const SESSION = /^[0-9a-f]{32}$/;
const EPOCH = /^e\d{3}$/;
const SEGMENT = /^(\d{6})\.ts$/;

interface Segment {
  file: string;
  number: number;
  seconds: number;
  utcEnd: number;
}

/** Closed segments of a recording epoch, oldest first (index.jsonl written by app/live/recorder.py). */
async function segments(folder: string): Promise<Segment[]> {
  const text = await readFile(path.join(folder, 'index.jsonl'), 'utf8').catch(() => '');
  const items: Segment[] = [];
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      const number = /^seg_(\d{6})\.mp4$/.exec(entry.file)?.[1];
      const seconds = Number(entry.pts_end) - Number(entry.pts_start);
      if (number && seconds > 0)
        items.push({
          file: entry.file,
          number: Number(number),
          seconds,
          utcEnd: Date.parse(entry.utc_end),
        });
    } catch {
      /* a blank or partial line */
    }
  }
  return items;
}

/**
 * Watching a camera as video. Network cameras record themselves in 10 s MP4 segments
 * (app/live/recorder.py); the live playlist lists the newest closed ones, remuxed to MPEG-TS
 * on request (stream copy, cached for an hour), so a browser plays them with HLS ~15-25 s
 * behind the camera. A demo camera replays a file: the client plays the same file at the
 * position the live process last reported.
 */
@ApiTags('Live streams')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/stream-sources')
export class LiveViewController {
  constructor(
    private db: Database,
    private owner: Ownership,
  ) {}

  /** Newest session of the camera and its newest recording epoch with closed segments. */
  private async latest(sourceId: string) {
    const session: Row | undefined = (
      await this.db.query(
        `SELECT id, status, stats FROM live_sessions WHERE stream_source_id=$1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
        [sourceId],
      )
    ).rows[0];
    if (!session) return null;
    const record = safeStorage(settings().dataDir, `live/${session.id}/record`);
    const epochs = (await readdir(record).catch(() => [] as string[]))
      .filter((name) => EPOCH.test(name))
      .sort()
      .reverse();
    for (const epoch of epochs) {
      const items = await segments(path.join(record, epoch));
      if (items.length) return { session, epoch, items };
    }
    return { session, epoch: null, items: [] as Segment[] };
  }

  @Get(':id/live-view')
  @ApiResponse({
    status: 200,
    description:
      'How to show the camera: `hls` (playlist of the rolling recording), `demo` (the demo file at the reported position), `youtube` (embed) or `snapshot` (no video yet: show the latest keyframe).',
    schema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['hls', 'demo', 'youtube', 'snapshot'] },
        url: { type: 'string', nullable: true },
        embed_url: { type: 'string', nullable: true },
        delay_seconds: {
          type: 'number',
          nullable: true,
          description: 'hls: about how far the video is behind the camera.',
        },
        duration: {
          type: 'number',
          nullable: true,
          description: 'demo: length of the replayed file.',
        },
        position_seconds: {
          type: 'number',
          nullable: true,
          description: 'demo: stream time the live process reached at position_at.',
        },
        position_at: { type: 'string', format: 'date-time', nullable: true },
        loop: {
          type: 'boolean',
          nullable: true,
          description:
            'demo: the file wraps around (demo cameras, looping uploads); false for an upload played once.',
        },
      },
    },
  })
  @ApiFailures(404)
  async liveView(@Req() req: { user: Actor }, @Param('id') id: string) {
    const camera = await this.owner.streamSource(req.user, id);
    const base = `/api/v2/stream-sources/${id}`;
    if (camera.source_type === 'youtube') {
      const video = youtubeVideoId(camera.url);
      return {
        kind: 'youtube',
        embed_url: video ? `https://www.youtube-nocookie.com/embed/${video}` : null,
      };
    }
    const latest = await this.latest(id);
    const active = latest !== null && ACTIVE_STATUSES.includes(latest.session.status);
    if (isReplay(camera)) {
      const stats = latest?.session.stats ?? {};
      const position = Number(stats.position_seconds);
      const duration = Number(stats.source_duration);
      if (active && Number.isFinite(position) && duration > 0 && stats.time)
        return {
          kind: 'demo',
          url: `${base}/demo-video`,
          duration,
          position_seconds: position,
          position_at: stats.time,
          // An upload played once stops at its end instead of wrapping around.
          loop: camera.source_type === 'file' || Boolean(camera.replay_loop),
        };
      return { kind: 'snapshot' };
    }
    if (active && latest.items.length) {
      const last = latest.items[latest.items.length - 1];
      return {
        kind: 'hls',
        url: `${base}/live.m3u8`,
        // The player starts about one segment before the newest closed one ends.
        delay_seconds: Math.max(0, Math.round((Date.now() - last.utcEnd) / 1000 + last.seconds)),
      };
    }
    return { kind: 'snapshot' };
  }

  @Get(':id/live.m3u8')
  @ApiFileResponse('application/vnd.apple.mpegurl')
  @ApiFailures(404)
  async playlist(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Query('asset_token') assetToken: unknown,
    @Res() response: Response,
  ) {
    await this.owner.streamSource(req.user, id);
    const latest = await this.latest(id);
    if (!latest?.epoch) throw new NotFoundException('This camera has no recording yet.');
    const { session, epoch, items } = latest;
    const shown = items.slice(-PLAYLIST_SEGMENTS);
    const epochNumber = Number(epoch.slice(1));
    // A query token (players that cannot send headers) is passed on to the segments.
    const query =
      typeof assetToken === 'string' ? `?asset_token=${encodeURIComponent(assetToken)}` : '';
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...shown.map((s) => s.seconds)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${epochNumber * 1_000_000 + shown[0].number}`,
      ...shown.flatMap((segment) => [
        `#EXTINF:${segment.seconds.toFixed(3)},`,
        `live/${session.id}/${epoch}/${String(segment.number).padStart(6, '0')}.ts${query}`,
      ]),
      ...(ACTIVE_STATUSES.includes(session.status) ? [] : ['#EXT-X-ENDLIST']),
    ];
    response
      .setHeader('Cache-Control', 'no-store')
      .type('application/vnd.apple.mpegurl')
      .send(`${lines.join('\n')}\n`);
  }

  @Get(':id/live/:session/:epoch/:file')
  @ApiFileResponse('video/mp2t')
  @ApiFailures(404)
  async segment(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Param('session') session: string,
    @Param('epoch') epoch: string,
    @Param('file') file: string,
    @Res() response: Response,
  ) {
    await this.owner.streamSource(req.user, id);
    const segment = SEGMENT.exec(file)?.[1];
    if (!SESSION.test(session) || !EPOCH.test(epoch) || !segment)
      throw new NotFoundException('Segment not found.');
    const owned = await this.db.query(
      'SELECT 1 FROM live_sessions WHERE id=$1 AND stream_source_id=$2',
      [session, id],
    );
    if (!owned.rowCount) throw new NotFoundException('Segment not found.');
    const { dataDir, python } = settings();
    const folder = safeStorage(dataDir, `live/${session}/record/${epoch}`);
    // Only closed segments (listed in the index): the open one is still being written.
    const listed = (await segments(folder)).find((s) => s.number === Number(segment));
    if (!listed) throw new NotFoundException('Segment not found.');
    const out = safeStorage(dataDir, `live/${session}/cache/hls-${epoch}-${segment}.ts`);
    if (!(await stat(out).catch(() => null))) {
      try {
        await remuxSegment(python, path.join(folder, listed.file), out);
      } catch {
        throw new NotFoundException('This part of the recording is no longer available.');
      }
    }
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.type('video/mp2t').sendFile(out);
  }

  @Get(':id/demo-video')
  @ApiRangedFileResponse('video/mp4')
  @ApiFailures(404)
  async demoVideo(@Req() req: { user: Actor }, @Param('id') id: string, @Res() response: Response) {
    const camera = await this.owner.streamSource(req.user, id);
    if (!isReplay(camera)) throw new NotFoundException('Not a camera replaying a video.');
    const replay = await replaySource(this.db, settings().dataDir, camera);
    if (!replay) throw new NotFoundException('The video is no longer available.');
    response.sendFile(replay.path);
  }
}
