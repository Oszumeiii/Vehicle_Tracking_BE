import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  HttpCode,
  UseGuards,
  ConflictException,
  UnprocessableEntityException,
  Injectable,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, checkDates, instant, newId, pagination } from '../common/http';
import { JOB_OWNER, JOB_SOURCES, Ownership } from '../common/ownership';
import {
  ApiCollectionResponse,
  ApiFailures,
  ApiPage,
  ApiPageResponse,
  ApiTimeRange,
} from '../common/openapi';
import {
  AcceptedJobResponse,
  AppearanceResponse,
  JobResponse,
  PipelineResponse,
} from '../common/api-models';
import { Storage } from '../media/storage';
import { AuthGuard } from '../auth/auth.guard';
import { PipelineRegistry } from '../recognition/registry';

const createSchema = z
  .object({
    media_id: z.string().min(1).max(64),
    pipeline_id: z.string().min(1).max(100),
    input_mode: z.enum(['scene', 'plate_crop']).default('scene'),
  })
  .strict();
const filterSchema = pagination
  .extend({
    origin: z.enum(['upload', 'live', 'all']).default('upload'),
    media_id: z.string().optional(),
    live_session_id: z.string().optional(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
    created_from: instant,
    created_to: instant,
  })
  .strict();
export function jobView(row: any) {
  const { pipeline_snapshot, ...value } = row;
  return {
    ...value,
    pipeline_id: pipeline_snapshot?.id ?? null,
    pipeline_version: pipeline_snapshot?.version ?? null,
    pipeline_task: pipeline_snapshot?.id ? (pipeline_snapshot.task ?? 'recognize') : null,
    status_url: `/api/v2/recognition-jobs/${row.id}`,
  };
}

@Injectable()
export class JobOperations {
  constructor(
    private db: Database,
    private owner: Ownership,
    private storage: Storage,
  ) {}
  async remove(actor: Actor, id: string) {
    let quarantined: Awaited<ReturnType<Storage['quarantine']>> | undefined;
    try {
      await this.db.transaction(async (c) => {
        const job = await this.owner.job(actor, id, false, c);
        // Lock the source consistently with job creation and media deletion.
        if (job.media_id) await this.owner.media(actor, job.media_id, c, true);
        else await this.owner.liveSession(actor, job.live_session_id, c, true);
        const locked = (
          await c.query('SELECT status FROM recognition_jobs WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!locked || !['succeeded', 'failed'].includes(locked.status))
          throw new ConflictException('Only finished jobs can be deleted.');
        quarantined = await this.storage.quarantine(`recognition/${id}`);
        await c.query('DELETE FROM recognition_jobs WHERE id=$1', [id]);
      });
    } catch (error) {
      await quarantined?.restore();
      throw error;
    }
    // A cleanup failure leaves only an inaccessible trash folder; the deletion is committed.
    await quarantined?.purge().catch(() => {});
  }
}

@ApiTags('Recognition jobs')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class JobsController {
  constructor(
    private db: Database,
    private owner: Ownership,
    private registry: PipelineRegistry,
    private operations: JobOperations,
  ) {}
  @Get('pipelines')
  @ApiCollectionResponse(PipelineResponse)
  @ApiFailures(503)
  async pipelines() {
    return { items: await this.registry.list() };
  }

  @Post('recognition-jobs')
  @HttpCode(202)
  @ApiResponse({ status: 202, type: AcceptedJobResponse })
  @ApiFailures(404, 503)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['media_id', 'pipeline_id'],
      additionalProperties: false,
      properties: {
        media_id: { type: 'string', minLength: 1, maxLength: 64 },
        pipeline_id: { type: 'string', minLength: 1, maxLength: 100 },
        input_mode: { type: 'string', enum: ['scene', 'plate_crop'], default: 'scene' },
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    const body = createSchema.parse(input);
    // Resolve ownership before model readiness to avoid leaking others' sources.
    const source = await this.owner.media(req.user, body.media_id);
    const snapshot = await this.registry.resolve(body.pipeline_id);
    if (snapshot.recognizer?.input_mode === 'five_frame_joint' && source.media_type !== 'video')
      throw new UnprocessableEntityException(
        'This OCR model requires five real frames from a video track. Use a prepare or single-image pipeline for images.',
      );
    return this.db.transaction(async (c) => {
      const media = await this.owner.media(req.user, body.media_id, c, true);
      if (media.media_type === 'video' && body.input_mode !== 'scene')
        throw new UnprocessableEntityException('Video input_mode must be scene.');
      const id = newId();
      await c.query(
        'INSERT INTO recognition_jobs(id,media_id,job_kind,input_mode,pipeline_snapshot) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          media.id,
          snapshot.task === 'prepare' ? 'detect_only' : 'recognize',
          body.input_mode,
          JSON.stringify(snapshot),
        ],
      );
      return { job_id: id, status: 'queued', status_url: `/api/v2/recognition-jobs/${id}` };
    });
  }

  @Get('recognition-jobs')
  @ApiPageResponse(JobResponse)
  @ApiPage()
  @ApiTimeRange('created_from', 'created_to')
  @ApiQuery({
    name: 'origin',
    required: false,
    enum: ['upload', 'live', 'all'],
    description: 'Uploaded media jobs by default; each finished live track is its own job.',
  })
  @ApiQuery({ name: 'media_id', required: false, type: String })
  @ApiQuery({ name: 'live_session_id', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['queued', 'running', 'succeeded', 'failed'] })
  async list(@Req() req: { user: Actor }, @Query() input: unknown) {
    const f = filterSchema.parse(input);
    checkDates(f.created_from, f.created_to);
    const values: unknown[] = [req.user.role === 'admin', req.user.id],
      clauses = [JOB_OWNER];
    if (f.origin !== 'all')
      clauses.push(
        f.origin === 'live' ? 'j.live_session_id IS NOT NULL' : 'j.media_id IS NOT NULL',
      );
    for (const [value, sql] of [
      [f.media_id, 'j.media_id='],
      [f.live_session_id, 'j.live_session_id='],
      [f.status, 'j.status='],
      [f.created_from, 'j.created_at>='],
      [f.created_to, 'j.created_at<='],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    }
    const from = `FROM ${JOB_SOURCES} WHERE ${clauses.join(' AND ')}`;
    const count = await this.db.query(`SELECT count(*) ${from}`, values);
    const items = await this.db.query(
      `SELECT j.* ${from} ORDER BY j.created_at DESC,j.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, f.limit, f.offset],
    );
    return {
      total: Number(count.rows[0].count),
      limit: f.limit,
      offset: f.offset,
      items: items.rows.map(jobView),
    };
  }
  @Get('recognition-jobs/:id')
  @ApiResponse({ status: 200, type: JobResponse })
  @ApiFailures(404)
  async get(@Req() req: { user: Actor }, @Param('id') id: string) {
    return jobView(await this.owner.job(req.user, id));
  }

  @Get('recognition-jobs/:id/results')
  @ApiPageResponse(AppearanceResponse)
  @ApiFailures(404, 409)
  @ApiPage()
  async results(@Req() req: { user: Actor }, @Param('id') id: string, @Query() input: unknown) {
    const { limit, offset } = pagination.parse(input);
    await this.owner.job(req.user, id, true);
    const count = await this.db.query('SELECT count(*) FROM plate_appearances WHERE job_id=$1', [
      id,
    ]);
    const items = await this.db.query(
      'SELECT * FROM plate_appearances WHERE job_id=$1 ORDER BY first_frame,id LIMIT $2 OFFSET $3',
      [id, limit, offset],
    );
    return { total: Number(count.rows[0].count), limit, offset, items: items.rows };
  }
  @Delete('recognition-jobs/:id')
  @HttpCode(204)
  @ApiResponse({
    status: 204,
    description: 'Finished job and derived evidence deleted; source retained.',
  })
  @ApiFailures(404, 409)
  remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    return this.operations.remove(req.user, id);
  }
}
