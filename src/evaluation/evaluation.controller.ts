import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, newId, normalizePlate } from '../common/http';
import { ApiFailures, ApiFileResponse } from '../common/openapi';
import { AuthGuard } from '../auth/auth.guard';
import { Storage } from '../media/storage';
import { BINS, sampleLiveTracks } from './sampling';
import { calibrationReport, LabelledItem } from './calibration';

const createSet = z
  .object({
    name: z.string().trim().min(1).max(200),
    stream_source_id: z.string().min(1).max(32).optional(),
    live_session_id: z.string().min(1).max(32).optional(),
    per_bin: z.number().int().min(1).max(200).default(30),
  })
  .strict()
  .refine((value) => Boolean(value.stream_source_id) !== Boolean(value.live_session_id), {
    message: 'Give exactly one of stream_source_id or live_session_id.',
  });
const label = z
  .object({
    plate_text: z
      .string()
      .max(32)
      .nullable()
      .transform((value) => (value === null ? null : normalizePlate(value)))
      .refine((value) => value === null || /^[A-Z0-9]{2,16}$/.test(value), {
        message: 'A plate has 2-16 letters or digits; send null if it cannot be read.',
      }),
  })
  .strict();
const report = z
  .object({
    target: z.coerce.number().gt(0).max(1).default(0.95),
    min_labels: z.coerce.number().int().min(1).max(10).default(1),
    format: z.enum(['report', 'files']).default('report'),
  })
  .strict();
const next = z
  .object({ exclude: z.string().max(8000).optional() })
  .strict()
  .transform((value) =>
    value.exclude ? value.exclude.split(',').filter(Boolean).slice(0, 300) : [],
  );

const SET_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    created_by: { type: 'string' },
    stream_source_id: { type: 'string', nullable: true },
    live_session_id: { type: 'string', nullable: true },
    params: { type: 'object', additionalProperties: true, description: 'per_bin and bin edges' },
    created_at: { type: 'string', format: 'date-time' },
    items: { type: 'integer' },
    labelled_items: { type: 'integer', description: 'Items with at least one label' },
    labelers: { type: 'integer' },
    my_labels: { type: 'integer', description: 'Items the caller has labelled' },
  },
};
const ITEM_SCHEMA = {
  type: 'object',
  description: 'Evidence only: never the machine text, confidence or review state.',
  properties: {
    id: { type: 'string' },
    set_id: { type: 'string' },
    crop_urls: { type: 'array', items: { type: 'string' } },
    frame_url: { type: 'string', nullable: true },
    my_label: {
      type: 'object',
      nullable: true,
      properties: {
        plate_text: { type: 'string', nullable: true },
        labeled_at: { type: 'string', format: 'date-time' },
      },
    },
  },
};
const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    item_id: { type: 'string' },
    plate_text: { type: 'string', nullable: true },
    labeled_at: { type: 'string', format: 'date-time' },
  },
};
const RATE = { type: 'number', nullable: true };
const REPORT_SCHEMA = {
  type: 'object',
  description: 'With format=files: {predictions, ground_truth} for scripts/calibrate_threshold.py.',
  properties: {
    set_id: { type: 'string' },
    items: { type: 'integer' },
    labelled: { type: 'integer' },
    samples: { type: 'integer', description: 'Consensus items used' },
    disagreements: { type: 'integer' },
    multi_labelled: { type: 'integer' },
    agreement: RATE,
    unreadable_by_labeller: { type: 'integer' },
    exact_match: RATE,
    target_precision: { type: 'number' },
    recommended_threshold: RATE,
    thresholds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          threshold: { type: 'number' },
          readable: { type: 'integer' },
          correct: { type: 'integer' },
          precision: RATE,
          coverage: { type: 'number' },
        },
      },
    },
    bins: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bin: { type: 'integer' },
          from: { type: 'number' },
          to: { type: 'number' },
          samples: { type: 'integer' },
          exact_match: RATE,
        },
      },
    },
  },
};

const admin = (actor: Actor) => {
  if (actor.role !== 'admin') throw new ForbiddenException('Administrator access required.');
};

const SET_VIEW = `SELECT s.*,
  (SELECT count(*)::int FROM evaluation_items i WHERE i.set_id=s.id) AS items,
  (SELECT count(DISTINCT l.item_id)::int FROM evaluation_labels l JOIN evaluation_items i ON i.id=l.item_id
    WHERE i.set_id=s.id) AS labelled_items,
  (SELECT count(DISTINCT l.labeler_id)::int FROM evaluation_labels l JOIN evaluation_items i ON i.id=l.item_id
    WHERE i.set_id=s.id) AS labelers,
  (SELECT count(*)::int FROM evaluation_labels l JOIN evaluation_items i ON i.id=l.item_id
    WHERE i.set_id=s.id AND l.labeler_id=$1) AS my_labels
  FROM evaluation_sets s`;

/**
 * Blind, independent labelling of sampled live tracks (docs/EVALUATION.md). Any user
 * can label; labellers see the five crops and one keyframe of a track but never the
 * machine text, its confidence or review state. Administrators create sets and read
 * the calibration report, which uses these labels and never in-app reviews.
 */
@ApiTags('Evaluation')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/evaluation-sets')
export class EvaluationController {
  constructor(
    private db: Database,
    private storage: Storage,
  ) {}

  private async set(actor: Actor, id: string) {
    const row = (await this.db.query(`${SET_VIEW} WHERE s.id=$2`, [actor.id, id])).rows[0];
    if (!row) throw new NotFoundException('Evaluation set not found.');
    return row;
  }

  /** What a labeller may see of an item: evidence only, plus their own label. */
  private async item(actor: Actor, setId: string, itemId: string) {
    const item = (
      await this.db.query(
        `SELECT i.id, i.set_id, a.id AS result_id, l.plate_text, l.labeled_at
        FROM evaluation_items i JOIN plate_appearances a ON a.job_id=i.job_id
        LEFT JOIN evaluation_labels l ON l.item_id=i.id AND l.labeler_id=$3
        WHERE i.id=$1 AND i.set_id=$2`,
        [itemId, setId, actor.id],
      )
    ).rows[0];
    if (!item) throw new NotFoundException('Evaluation item not found.');
    const detections = (
      await this.db.query(
        `SELECT selected_order, frame_storage_key FROM plate_detections
        WHERE appearance_id=$1 ORDER BY selected_order`,
        [item.result_id],
      )
    ).rows;
    const base = `/api/v2/evaluation-sets/${setId}/items/${item.id}/artifacts`;
    // The middle keyframe survives retention pruning; fall back to any other kept one.
    const frame =
      detections.find((d) => d.selected_order === 3 && d.frame_storage_key) ??
      detections.find((d) => d.frame_storage_key);
    return {
      id: item.id,
      set_id: item.set_id,
      crop_urls: detections.map((d) => `${base}/${d.selected_order}/crop`),
      frame_url: frame ? `${base}/${frame.selected_order}/frame` : null,
      my_label: item.labeled_at
        ? { plate_text: item.plate_text, labeled_at: item.labeled_at }
        : null,
    };
  }

  @Post()
  @ApiResponse({
    status: 201,
    description: 'Set created with a stratified sample of tracks.',
    schema: SET_SCHEMA,
  })
  @ApiFailures(403, 404)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 200 },
        stream_source_id: { type: 'string', description: 'Sample this camera (all sessions)' },
        live_session_id: { type: 'string', description: 'Or one session' },
        per_bin: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 30,
          description: `Tracks per confidence bin; bins start at ${BINS.slice(0, -1).join(', ')}`,
        },
      },
    },
  })
  async create(@Req() req: { user: Actor }, @Body() input: unknown) {
    admin(req.user);
    const body = createSet.parse(input);
    const table = body.stream_source_id ? 'stream_sources' : 'live_sessions';
    const sourceId = body.stream_source_id ?? body.live_session_id;
    if (!(await this.db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [sourceId])).rowCount)
      throw new NotFoundException(
        body.stream_source_id ? 'Stream source not found.' : 'Live session not found.',
      );
    const tracks = await sampleLiveTracks(
      this.db,
      { source: body.stream_source_id, session: body.live_session_id },
      body.per_bin,
    );
    if (!tracks.length) throw new UnprocessableEntityException('No live tracks to sample yet.');
    const id = newId();
    await this.db.transaction(async (c) => {
      await c.query(
        `INSERT INTO evaluation_sets(id,name,created_by,stream_source_id,live_session_id,params)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          id,
          body.name,
          req.user.id,
          body.stream_source_id ?? null,
          body.live_session_id ?? null,
          JSON.stringify({ per_bin: body.per_bin, bins: BINS.slice(0, -1) }),
        ],
      );
      for (const track of tracks)
        await c.query('INSERT INTO evaluation_items(id,set_id,job_id,bin) VALUES($1,$2,$3,$4)', [
          newId(),
          id,
          track.job_id,
          track.bin,
        ]);
    });
    return this.set(req.user, id);
  }

  @Get()
  @ApiResponse({
    status: 200,
    description: 'All sets with overall and personal progress.',
    schema: { type: 'object', properties: { items: { type: 'array', items: SET_SCHEMA } } },
  })
  async list(@Req() req: { user: Actor }) {
    const items = (
      await this.db.query(`${SET_VIEW} ORDER BY s.created_at DESC, s.id DESC`, [req.user.id])
    ).rows;
    return { items };
  }

  @Get(':id')
  @ApiResponse({
    status: 200,
    description: 'One set with overall and personal progress.',
    schema: SET_SCHEMA,
  })
  @ApiFailures(404)
  get(@Req() req: { user: Actor }, @Param('id') id: string) {
    return this.set(req.user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Set and its labels deleted; tracks are kept.' })
  @ApiFailures(403, 404)
  async remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    admin(req.user);
    const result = await this.db.query('DELETE FROM evaluation_sets WHERE id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException('Evaluation set not found.');
  }

  @Get(':id/next')
  @ApiQuery({
    name: 'exclude',
    required: false,
    description: 'Comma-separated item ids skipped in this sitting',
  })
  @ApiResponse({
    status: 200,
    description:
      'The next item this user has not labelled, in an order stable per user, or null when done.',
    schema: {
      type: 'object',
      properties: {
        remaining: { type: 'integer' },
        item: { ...ITEM_SCHEMA, nullable: true },
      },
    },
  })
  @ApiFailures(404)
  async next(@Req() req: { user: Actor }, @Param('id') id: string, @Query() input: unknown) {
    const exclude = next.parse(input);
    await this.set(req.user, id);
    // A different, stable order per labeller spreads labellers over the set.
    const rows = (
      await this.db.query(
        `SELECT i.id FROM evaluation_items i
        WHERE i.set_id=$1 AND NOT EXISTS (
          SELECT 1 FROM evaluation_labels l WHERE l.item_id=i.id AND l.labeler_id=$2)
        ORDER BY md5($2 || i.id)`,
        [id, req.user.id],
      )
    ).rows;
    const pick = rows.find((row) => !exclude.includes(row.id));
    return { remaining: rows.length, item: pick ? await this.item(req.user, id, pick.id) : null };
  }

  @Get(':id/items/:item')
  @ApiResponse({
    status: 200,
    description: 'Evidence of one item and this user’s label.',
    schema: ITEM_SCHEMA,
  })
  @ApiFailures(404)
  async getItem(@Req() req: { user: Actor }, @Param('id') id: string, @Param('item') item: string) {
    return this.item(req.user, id, item);
  }

  @Put(':id/items/:item/label')
  @ApiResponse({
    status: 200,
    description: 'This user’s label, created or replaced.',
    schema: LABEL_SCHEMA,
  })
  @ApiFailures(404)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['plate_text'],
      additionalProperties: false,
      properties: {
        plate_text: {
          type: 'string',
          nullable: true,
          description: 'Plate read from the crops; null when a person cannot read it either',
        },
      },
    },
  })
  async label(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Param('item') item: string,
    @Body() input: unknown,
  ) {
    const body = label.parse(input);
    if (
      !(await this.db.query('SELECT 1 FROM evaluation_items WHERE id=$1 AND set_id=$2', [item, id]))
        .rowCount
    )
      throw new NotFoundException('Evaluation item not found.');
    return (
      await this.db.query(
        `INSERT INTO evaluation_labels(item_id,labeler_id,plate_text) VALUES($1,$2,$3)
        ON CONFLICT (item_id,labeler_id) DO UPDATE SET plate_text=EXCLUDED.plate_text, labeled_at=now()
        RETURNING item_id, plate_text, labeled_at`,
        [item, req.user.id, body.plate_text],
      )
    ).rows[0];
  }

  @Get(':id/items/:item/artifacts/:order/:kind')
  @ApiParam({ name: 'kind', enum: ['crop', 'frame'] })
  @ApiFileResponse('image/jpeg', 'image/png')
  @ApiFailures(404)
  async artifact(
    @Param('id') id: string,
    @Param('item') item: string,
    @Param('order') order: string,
    @Param('kind') kind: string,
    @Res() response: Response,
  ) {
    const which = z.enum(['crop', 'frame']).parse(kind);
    const detection = (
      await this.db.query(
        `SELECT d.crop_storage_key, d.frame_storage_key FROM evaluation_items i
        JOIN plate_appearances a ON a.job_id=i.job_id JOIN plate_detections d ON d.appearance_id=a.id
        WHERE i.id=$1 AND i.set_id=$2 AND d.selected_order=$3`,
        [item, id, Number.parseInt(order, 10) || 0],
      )
    ).rows[0];
    const key = which === 'crop' ? detection?.crop_storage_key : detection?.frame_storage_key;
    if (!key) throw new NotFoundException('Artifact not found.');
    response.sendFile(await this.storage.file(key));
  }

  @Get(':id/report')
  @ApiQuery({ name: 'target', required: false, description: 'Target precision, default 0.95' })
  @ApiQuery({ name: 'min_labels', required: false, description: 'Labels an item needs, default 1' })
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['report', 'files'],
    description: 'files: predictions and ground truth for scripts/calibrate_threshold.py',
  })
  @ApiResponse({
    status: 200,
    description:
      'Precision and coverage of "readable" per confidence threshold, labeller agreement and accuracy per bin.',
    schema: REPORT_SCHEMA,
  })
  @ApiFailures(403, 404)
  async report(@Req() req: { user: Actor }, @Param('id') id: string, @Query() input: unknown) {
    admin(req.user);
    const options = report.parse(input);
    const set = await this.set(req.user, id);
    const rows = (
      await this.db.query(
        `SELECT i.id AS item_id, i.job_id, i.bin, a.machine_text,
          (j.statistics->>'confidence')::float AS confidence,
          coalesce(json_agg(json_build_object('plate_text', l.plate_text))
            FILTER (WHERE l.labeler_id IS NOT NULL), '[]') AS labels
        FROM evaluation_items i JOIN recognition_jobs j ON j.id=i.job_id
        JOIN plate_appearances a ON a.job_id=i.job_id
        LEFT JOIN evaluation_labels l ON l.item_id=i.id
        WHERE i.set_id=$1 GROUP BY i.id, a.machine_text, j.statistics ORDER BY i.id`,
        [id],
      )
    ).rows.map((row: any): LabelledItem => ({
      ...row,
      labels: row.labels.map((l: { plate_text: string | null }) => l.plate_text),
    }));
    if (options.format === 'files') {
      // Only consensus items, as the report uses them; the script then recomputes it.
      const agreed = rows.filter(
        (row) => row.labels.length >= options.min_labels && new Set(row.labels).size === 1,
      );
      return {
        predictions: {
          predictions: agreed.map((row) => ({
            sample_id: row.item_id,
            variant: 'five_image',
            detected: true,
            plate_text: row.machine_text,
            confidence: row.confidence,
          })),
        },
        ground_truth: {
          samples: agreed.map((row) => ({
            sample_id: row.item_id,
            source_id: set.stream_source_id ?? set.live_session_id,
            split: 'test',
            plate_text: row.labels[0],
          })),
        },
      };
    }
    return {
      set_id: id,
      ...calibrationReport(rows, {
        targetPrecision: options.target,
        minLabels: options.min_labels,
        bins: BINS,
      }),
    };
  }
}
