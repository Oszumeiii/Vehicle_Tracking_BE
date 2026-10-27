import {
  BadRequestException,
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
import { readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { settings } from '../common/config';
import { Actor } from '../common/http';
import { ApiFailures, ApiRangedFileResponse } from '../common/openapi';
import { Ownership } from '../common/ownership';
import { Database } from '../database/database';
import { safeStorage } from '../recognition/engine';
import { coverage, cutRecording, NotRecorded, recordingIndexes } from './clips';

type Row = Record<string, any>;
const PAD_SECONDS = 3;
const MAX_RECORDING_SECONDS = 600;
const OFFSET_HEADER = 'X-Plate-First-Seen-Seconds';

/** Where a result's video is: its clip, the camera's rolling recording, the uploaded video, or nowhere. */
interface VideoSource {
  kind: 'clip' | 'recording' | 'media' | 'none';
  /** Seconds into the video where the plate first shows. */
  first_seen_offset: number | null;
  job: Row;
}

/**
 * Video of a recognition result: the clip of a live track (or a cut of the camera's rolling
 * recording while it is kept), and stretches of a camera's recording by time. Cuts are stream
 * copies (python -m app.live.clips), cached for an hour under live/{session}/cache.
 */
@ApiTags('Live streams')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class VideoController {
  constructor(
    private db: Database,
    private owner: Ownership,
  ) {}

  private async source(actor: Actor, id: string): Promise<VideoSource> {
    const result = await this.owner.result(actor, id);
    const job = (
      await this.db.query(
        `SELECT id, media_id, live_session_id, captured_from, captured_to, clip_storage_key, statistics
         FROM recognition_jobs WHERE id=$1`,
        [result.job_id],
      )
    ).rows[0];
    if (job.media_id)
      return { kind: 'media', first_seen_offset: Number(result.start_seconds ?? 0), job };
    if (job.clip_storage_key)
      return {
        kind: 'clip',
        first_seen_offset: Number(job.statistics?.clip_first_seen_offset ?? PAD_SECONDS),
        job,
      };
    const recorded = await coverage(
      await recordingIndexes(settings().dataDir, [job.live_session_id]),
    );
    const from = new Date(job.captured_from).getTime();
    const to = new Date(job.captured_to).getTime();
    const covered = recorded.some(
      (span) => Date.parse(span.from) <= from && Date.parse(span.to) >= to,
    );
    return { kind: covered ? 'recording' : 'none', first_seen_offset: null, job };
  }

  @Get('recognition-results/:id/video-info')
  @ApiResponse({
    status: 200,
    description:
      'Which video shows this result: `clip` (kept with the track), `recording` (cut from the camera recording while it is kept), `media` (the uploaded video) or `none`.',
    schema: {
      type: 'object',
      required: ['available', 'kind', 'url', 'first_seen_offset'],
      properties: {
        available: { type: 'boolean' },
        kind: { type: 'string', enum: ['clip', 'recording', 'media', 'none'] },
        url: { type: 'string', nullable: true },
        first_seen_offset: {
          type: 'number',
          nullable: true,
          description: 'Seconds into the video where the plate first shows.',
        },
        captured_from: { type: 'string', format: 'date-time', nullable: true },
        captured_to: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiFailures(404)
  async videoInfo(@Req() req: { user: Actor }, @Param('id') id: string) {
    const video = await this.source(req.user, id);
    const url =
      video.kind === 'media'
        ? `/api/v2/media/${video.job.media_id}/content`
        : video.kind === 'none'
          ? null
          : `/api/v2/recognition-results/${id}/video`;
    return {
      available: video.kind !== 'none',
      kind: video.kind,
      url,
      first_seen_offset: video.first_seen_offset,
      captured_from: video.job.captured_from,
      captured_to: video.job.captured_to,
    };
  }

  @Get('recognition-results/:id/video')
  @ApiRangedFileResponse('video/mp4')
  @ApiFailures(404)
  async video(@Req() req: { user: Actor }, @Param('id') id: string, @Res() response: Response) {
    const video = await this.source(req.user, id);
    const { dataDir, python } = settings();
    let file: string;
    let offset = video.first_seen_offset;
    if (video.kind === 'clip') file = safeStorage(dataDir, video.job.clip_storage_key);
    else if (video.kind === 'recording') {
      file = safeStorage(dataDir, `live/${video.job.live_session_id}/cache/${video.job.id}.mp4`);
      const sidecar = `${file}.json`;
      const cached = await readFile(sidecar, 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (cached && (await stat(file).catch(() => null))) offset = cached.first_seen_offset;
      else {
        const from = new Date(new Date(video.job.captured_from).getTime() - PAD_SECONDS * 1000);
        const to = new Date(new Date(video.job.captured_to).getTime() + PAD_SECONDS * 1000);
        const info = await this.cut(
          python,
          [video.job.live_session_id],
          from.toISOString(),
          to.toISOString(),
          file,
        );
        offset = info.first_seen_offset + PAD_SECONDS;
        await writeFile(sidecar, JSON.stringify({ first_seen_offset: offset }));
      }
    } else throw new NotFoundException('This result has no video any more.');
    response.setHeader(OFFSET_HEADER, String(offset ?? 0));
    response.setHeader('Access-Control-Expose-Headers', OFFSET_HEADER);
    response.type('video/mp4').sendFile(file);
  }

  @Get('stream-sources/:id/recording/coverage')
  @ApiResponse({
    status: 200,
    description:
      'Wall-clock intervals of the camera that are still recorded (merged across sessions).',
    schema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiFailures(404)
  async coverage(@Req() req: { user: Actor }, @Param('id') id: string) {
    await this.owner.streamSource(req.user, id);
    return { items: await coverage(await this.indexes(id)) };
  }

  @Get('stream-sources/:id/recording')
  @ApiRangedFileResponse('video/mp4')
  @ApiFailures(400, 404)
  async recording(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() response: Response,
  ) {
    await this.owner.streamSource(req.user, id);
    const parsed = z
      .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
      .parse(query);
    const from = new Date(parsed.from).toISOString();
    const to = new Date(parsed.to).toISOString();
    const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
    if (!(seconds > 0 && seconds <= MAX_RECORDING_SECONDS))
      throw new BadRequestException(
        `A recording request spans 1 to ${MAX_RECORDING_SECONDS} seconds.`,
      );
    const { dataDir, python } = settings();
    const name = `${id}-${Date.parse(from)}-${Date.parse(to)}.mp4`;
    const file = safeStorage(dataDir, `live/recording-cache/${name}`);
    const info = await this.cut(python, null, from, to, file, id);
    response.setHeader(OFFSET_HEADER, String(info.first_seen_offset));
    response.setHeader('Access-Control-Expose-Headers', OFFSET_HEADER);
    response.type('video/mp4').sendFile(file);
  }

  private async indexes(sourceId: string) {
    const sessions = (
      await this.db.query('SELECT id FROM live_sessions WHERE stream_source_id=$1', [sourceId])
    ).rows.map((row) => row.id);
    return recordingIndexes(settings().dataDir, sessions);
  }

  private async cut(
    python: string,
    sessions: string[] | null,
    from: string,
    to: string,
    out: string,
    sourceId?: string,
  ) {
    const files = sessions
      ? await recordingIndexes(settings().dataDir, sessions)
      : await this.indexes(sourceId!);
    try {
      return await cutRecording({ python }, files, from, to, out);
    } catch (error) {
      if (error instanceof NotRecorded)
        throw new NotFoundException('This time is no longer recorded.');
      throw error;
    }
  }
}
