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
  UseGuards,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, pagination } from '../common/http';
import { Ownership } from '../common/ownership';
import { ApiFailures, ApiPage, ApiPageResponse } from '../common/openapi';
import {
  LiveEventResponse,
  LiveSessionResponse,
  StreamSourceResponse,
  streamZones,
} from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { PipelineRegistry } from '../recognition/registry';
import { excludeZones, isLivePipeline, isYoutubeUrl } from './payload';
import { ACTIVE_SQL, ACTIVE_STATUSES, recordEvent, sessionView } from './sessions';

const name = z.string().trim().min(1).max(200);
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
      return { ...row, active_session: session ? sessionView(session) : null };
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
    return { ...row, active_session: null };
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
