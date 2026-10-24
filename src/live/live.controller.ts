import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiHeader,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, pagination } from '../common/http';
import { Ownership } from '../common/ownership';
import { ApiFailures, ApiFileResponse, ApiPage, ApiPageResponse } from '../common/openapi';
import {
  AlertEventPayload,
  LiveEventResponse,
  TrackEventPayload,
  LiveSessionResponse,
  StreamSourceResponse,
  streamZones,
} from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { PipelineRegistry } from '../recognition/registry';
import { Storage } from '../media/storage';
import { LiveEventsHub } from './events.hub';
import { excludeZones, isLivePipeline, isYoutubeUrl, youtubeVideoId } from './payload';
import { ACTIVE_SQL, ACTIVE_STATUSES, recordEvent, sessionView } from './sessions';

const name = z.string().trim().min(1).max(200);
const eventId = z.string().regex(/^\d{1,18}$/, 'Event ids are non-negative integers.');
const streamFilter = z
  .object({
    live_session_id: z.string().optional(),
    stream_source_id: z.string().optional(),
    after: eventId.optional(),
  })
  .strict();

function sourceView(row: Record<string, any>) {
  const videoId = youtubeVideoId(row.url);
  return {
    ...row,
    video_id: videoId,
    embed_url: videoId ? `https://www.youtube-nocookie.com/embed/${videoId}` : null,
  };
}
const createSource = z
  .object({
    name,
    url: z
      .string()
      .max(2000)
      .refine(isYoutubeUrl, { message: 'Provide a YouTube watch or live URL.' }),
    exclude_zones: excludeZones.default([]),
  })
  .strict();
const updateSource = z
  .object({ name: name.optional(), exclude_zones: excludeZones.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });
const startSession = z
  .object({
    pipeline_id: z.string().min(1).max(100),
    min_confidence: z.number().min(0).max(1).default(0.85),
    max_track_seconds: z.number().min(5).max(300).default(30),
  })
  .strict();
const sessionFilter = pagination
  .extend({
    stream_source_id: z.string().optional(),
    status: z
      .enum([
        'queued',
        'starting',
        'running',
        'reconnecting',
        'stopping',
        'stopped',
        'ended',
        'failed',
        'interrupted',
      ])
      .optional(),
  })
  .strict();

@ApiTags('Live streams')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class LiveController {
  constructor(
    private db: Database,
    private owner: Ownership,
    private registry: PipelineRegistry,
    private storage: Storage,
    private hub: LiveEventsHub,
  ) {}

  private async withActive(rows: Record<string, any>[]) {
    const active = rows.length
      ? (
          await this.db.query(
            `SELECT * FROM live_sessions WHERE stream_source_id=ANY($1) AND status IN ${ACTIVE_SQL}`,
            [rows.map((row) => row.id)],
          )
        ).rows
      : [];
    return rows.map((row) => {
      const session = active.find((s) => s.stream_source_id === row.id);
      return { ...sourceView(row), active_session: session ? sessionView(session) : null };
    });
  }

  @Post('stream-sources')
  @ApiResponse({ status: 201, type: StreamSourceResponse })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'url'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        url: { type: 'string', description: 'YouTube watch or live URL' },
        exclude_zones: streamZones,
      },
    },
  })
  async createSource(@Req() req: { user: Actor }, @Body() input: unknown) {
    const body = createSource.parse(input);
    const row = (
      await this.db.query(
        'INSERT INTO stream_sources(id,owner_id,name,url,exclude_zones) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [newId(), req.user.id, body.name, body.url, JSON.stringify(body.exclude_zones)],
      )
    ).rows[0];
    return { ...sourceView(row), active_session: null };
  }

  @Get('stream-sources/:id/snapshot')
  @ApiFileResponse('image/jpeg')
  @ApiFailures(404)
  @ApiResponse({
    status: 200,
    description:
      'Latest keyframe recorded on this camera, for drawing exclude zones in normalized coordinates.',
  })
  async snapshot(@Req() req: { user: Actor }, @Param('id') id: string, @Res() res: Response) {
    await this.owner.streamSource(req.user, id);
    const frame = (
      await this.db.query(
        `SELECT d.frame_storage_key FROM recognition_jobs j
        JOIN live_sessions s ON s.id=j.live_session_id
        JOIN plate_appearances a ON a.job_id=j.id JOIN plate_detections d ON d.appearance_id=a.id
        WHERE s.stream_source_id=$1 ORDER BY j.captured_to DESC, d.selected_order DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (!frame) throw new NotFoundException('No frame from this camera yet; run a session first.');
    res.sendFile(await this.storage.file(frame.frame_storage_key));
  }

  @Get('live-events/stream')
  @ApiProduces('text/event-stream')
  @ApiExtraModels(TrackEventPayload, AlertEventPayload)
  @ApiQuery({ name: 'live_session_id', required: false, type: String })
  @ApiQuery({ name: 'stream_source_id', required: false, type: String })
  @ApiQuery({
    name: 'after',
    required: false,
    type: String,
    description: 'Replay events after this id (0 = all); Last-Event-ID takes precedence.',
  })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'Id of the last event received; the stream resumes after it.',
  })
  @ApiResponse({
    status: 200,
    description: [
      'Server-sent events. Durable events carry an id and the data',
      '`{live_session_id, stream_source_id, created_at, payload}`: `status`, `error`,',
      '`track_rejected`, `track` (payload ' + getSchemaPath(TrackEventPayload) + ') and',
      '`alert` (payload ' + getSchemaPath(AlertEventPayload) + ', only to the watchlist owner).',
      '`session` (no id) carries the current session view on connect and on every change,',
      'including stats. A stream filtered by live_session_id sends `end` and closes after the',
      'terminal status. Without a filter it covers every session you can see. Comment lines',
      'are heartbeats. Authenticate with the Bearer header: browsers must read the stream',
      'with fetch, since EventSource cannot send headers.',
    ].join(' '),
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiFailures(404, 503)
  async stream(
    @Req() req: Request & { user: Actor },
    @Query() input: unknown,
    @Res() res: Response,
  ) {
    const filter = streamFilter.parse(input);
    if (filter.live_session_id) await this.owner.liveSession(req.user, filter.live_session_id);
    if (filter.stream_source_id) await this.owner.streamSource(req.user, filter.stream_source_id);
    const header = req.headers['last-event-id'];
    const after = header === undefined ? filter.after : eventId.parse(String(header));
    await this.hub.open(
      req.user,
      { live_session_id: filter.live_session_id, stream_source_id: filter.stream_source_id },
      after,
      req,
      res,
    );
  }

  @Get('stream-sources')
  @ApiPageResponse(StreamSourceResponse)
  @ApiPage()
  async listSources(@Req() req: { user: Actor }, @Query() input: unknown) {
    const { limit, offset } = pagination.strict().parse(input);
    const values = [req.user.role === 'admin', req.user.id];
    const where = 'WHERE ($1::boolean OR owner_id=$2)';
    const count = await this.db.query(`SELECT count(*) FROM stream_sources ${where}`, values);
    const items = await this.db.query(
      `SELECT * FROM stream_sources ${where} ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
      [...values, limit, offset],
    );
    return {
      total: Number(count.rows[0].count),
      limit,
      offset,
      items: await this.withActive(items.rows),
    };
  }

  @Get('stream-sources/:id')
  @ApiResponse({ status: 200, type: StreamSourceResponse })
  @ApiFailures(404)
  async getSource(@Req() req: { user: Actor }, @Param('id') id: string) {
    return (await this.withActive([await this.owner.streamSource(req.user, id)]))[0];
  }

  @Patch('stream-sources/:id')
  @ApiResponse({ status: 200, type: StreamSourceResponse })
  @ApiFailures(404)
  @ApiBody({
    description: 'Changes apply from the next session; a running session keeps its settings.',
    schema: {
      type: 'object',
      minProperties: 1,
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        exclude_zones: streamZones,
      },
    },
  })
  async updateSource(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = updateSource.parse(input);
    const row = await this.db.transaction(async (c) => {
      const source = await this.owner.streamSource(req.user, id, c, true);
      return (
        await c.query(
          `UPDATE stream_sources SET name=$2,exclude_zones=$3,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            id,
            body.name ?? source.name,
            JSON.stringify(body.exclude_zones ?? source.exclude_zones),
          ],
        )
      ).rows[0];
    });
    return (await this.withActive([row]))[0];
  }

  @Delete('stream-sources/:id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Camera without sessions deleted.' })
  @ApiFailures(404, 409)
  async removeSource(@Req() req: { user: Actor }, @Param('id') id: string) {
    await this.db.transaction(async (c) => {
      await this.owner.streamSource(req.user, id, c, true);
      if (
        (await c.query('SELECT 1 FROM live_sessions WHERE stream_source_id=$1 LIMIT 1', [id]))
          .rowCount
      )
        throw new ConflictException(
          'This camera has sessions and their results; it cannot be deleted.',
        );
      await c.query('DELETE FROM stream_sources WHERE id=$1', [id]);
    });
  }

  @Post('stream-sources/:id/sessions')
  @HttpCode(202)
  @ApiResponse({ status: 202, type: LiveSessionResponse })
  @ApiFailures(404, 409, 503)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['pipeline_id'],
      additionalProperties: false,
      properties: {
        pipeline_id: { type: 'string', minLength: 1, maxLength: 100 },
        min_confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.85,
          description: 'OCR confidence from which a track is marked readable (advisory).',
        },
        max_track_seconds: {
          type: 'number',
          minimum: 5,
          maximum: 300,
          default: 30,
          description: 'Open tracks (parked or queued cars) are finished after this long.',
        },
      },
    },
  })
  async startSession(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = startSession.parse(input);
    // Resolve ownership before model readiness to avoid leaking others' cameras.
    await this.owner.streamSource(req.user, id);
    const snapshot = await this.registry.resolve(body.pipeline_id);
    if (!isLivePipeline(snapshot))
      throw new UnprocessableEntityException(
        'Live recognition needs a five-frame joint OCR pipeline.',
      );
    try {
      return await this.db.transaction(async (c) => {
        const source = await this.owner.streamSource(req.user, id, c, true);
        const settings = {
          min_confidence: body.min_confidence,
          max_track_seconds: body.max_track_seconds,
          exclude_zones: source.exclude_zones,
        };
        const row = (
          await c.query(
            `INSERT INTO live_sessions(id,stream_source_id,requested_by,pipeline_snapshot,settings)
            VALUES($1,$2,$3,$4,$5) RETURNING *`,
            [newId(), id, req.user.id, JSON.stringify(snapshot), JSON.stringify(settings)],
          )
        ).rows[0];
        await recordEvent(c, row.id, 'status', { status: 'queued' });
        return sessionView(row);
      });
    } catch (error) {
      if ((error as any)?.code === '23505')
        throw new ConflictException('This camera already has an active session.');
      throw error;
    }
  }

  @Get('live-sessions')
  @ApiPageResponse(LiveSessionResponse)
  @ApiPage()
  @ApiQuery({ name: 'stream_source_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...ACTIVE_STATUSES, 'stopped', 'ended', 'failed', 'interrupted'],
  })
  async listSessions(@Req() req: { user: Actor }, @Query() input: unknown) {
    const f = sessionFilter.parse(input);
    const values: unknown[] = [req.user.role === 'admin', req.user.id],
      clauses = ['($1::boolean OR c.owner_id=$2)'];
    for (const [value, sql] of [
      [f.stream_source_id, 's.stream_source_id='],
      [f.status, 's.status='],
    ] as const)
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    const from = `FROM live_sessions s JOIN stream_sources c ON c.id=s.stream_source_id WHERE ${clauses.join(' AND ')}`;
    const count = await this.db.query(`SELECT count(*) ${from}`, values);
    const items = await this.db.query(
      `SELECT s.* ${from} ORDER BY s.created_at DESC,s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, f.limit, f.offset],
    );
    return {
      total: Number(count.rows[0].count),
      limit: f.limit,
      offset: f.offset,
      items: items.rows.map(sessionView),
    };
  }

  @Get('live-sessions/:id')
  @ApiResponse({ status: 200, type: LiveSessionResponse })
  @ApiFailures(404)
  async getSession(@Req() req: { user: Actor }, @Param('id') id: string) {
    return sessionView(await this.owner.liveSession(req.user, id));
  }

  @Post('live-sessions/:id/stop')
  @HttpCode(202)
  @ApiResponse({
    status: 202,
    type: LiveSessionResponse,
    description:
      'A queued session stops at once; a running one finishes and recognizes its open tracks first.',
  })
  @ApiFailures(404, 409)
  async stopSession(@Req() req: { user: Actor }, @Param('id') id: string) {
    return this.db.transaction(async (c) => {
      const session = await this.owner.liveSession(req.user, id, c, true);
      if (!ACTIVE_STATUSES.includes(session.status))
        throw new ConflictException('This session has already finished.');
      const queued = session.status === 'queued';
      const row = (
        await c.query(
          `UPDATE live_sessions SET stop_requested_at=coalesce(stop_requested_at,now())
          ${queued ? ",status='stopped',finished_at=now()" : ''} WHERE id=$1 RETURNING *`,
          [id],
        )
      ).rows[0];
      if (queued) await recordEvent(c, id, 'status', { status: 'stopped' });
      return sessionView(row);
    });
  }

  @Get('live-sessions/:id/events')
  @ApiPageResponse(LiveEventResponse)
  @ApiPage()
  @ApiFailures(404)
  async events(@Req() req: { user: Actor }, @Param('id') id: string, @Query() input: unknown) {
    const { limit, offset } = pagination.strict().parse(input);
    await this.owner.liveSession(req.user, id);
    const count = await this.db.query(
      'SELECT count(*) FROM live_session_events WHERE session_id=$1',
      [id],
    );
    const items = await this.db.query(
      `SELECT id::text AS id,event_type,payload,created_at FROM live_session_events
      WHERE session_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return { total: Number(count.rows[0].count), limit, offset, items: items.rows };
  }
}
