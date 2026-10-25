import {
  Body,
  Controller,
  Get,
  Post,
  Param,
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
  ApiTags,
  ApiQuery,
  ApiProduces,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, checkDates, instant, newId, normalizePlate, pagination } from '../common/http';
import { JOB_OWNER, JOB_SOURCES, Ownership } from '../common/ownership';
import {
  ApiFailures,
  ApiFileResponse,
  ApiPage,
  ApiPageResponse,
  ApiTimeRange,
} from '../common/openapi';
import { ResultDetailResponse, ReviewResponse, SearchResultResponse } from '../common/api-models';
import { Storage } from '../media/storage';
import { AuthGuard } from '../auth/auth.guard';

const search = pagination
  .extend({
    plate: z.string().max(128).optional(),
    origin: z.enum(['upload', 'live']).optional(),
    media_id: z.string().optional(),
    stream_source_id: z.string().optional(),
    live_session_id: z.string().optional(),
    review_status: z
      .enum(['pending', 'confirmed', 'corrected', 'unreadable', 'rejected'])
      .optional(),
    confidence_status: z.enum(['readable', 'low_confidence', 'unreadable']).optional(),
    exclude_duplicates: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    uploaded_from: instant,
    uploaded_to: instant,
    captured_from: instant,
    captured_to: instant,
    group_by: z.enum(['sighting']).optional(),
  })
  .strict();
// A live sighting groups the tracks of one vehicle passage; every upload result stands alone.
const SIGHTING = 'coalesce(j.sighting_id, a.id)';
const RESULT_FIELDS = `a.*,j.media_id,m.uploaded_at,
  CASE WHEN j.live_session_id IS NULL THEN 'upload' ELSE 'live' END AS origin,
  s.stream_source_id,j.live_session_id,j.captured_from,j.captured_to,j.confidence_status,
  j.duplicate_of_job_id,j.sighting_id`;
const review = z
  .object({
    action: z.enum(['confirm', 'correct', 'unreadable', 'reject']),
    corrected_text: z.string().min(1).max(64).optional(),
    note: z.string().max(2000).optional(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => (v.action === 'correct') === (v.corrected_text !== undefined), {
    message: 'corrected_text is required only for correct action.',
  });

@ApiTags('Results and review')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class ResultsController {
  constructor(
    private db: Database,
    private owner: Ownership,
    private storage: Storage,
  ) {}
  @Get('recognition-results')
  @ApiPageResponse(SearchResultResponse)
  @ApiPage()
  @ApiTimeRange('uploaded_from', 'uploaded_to')
  @ApiQuery({
    name: 'plate',
    required: false,
    type: String,
    description: 'Exact normalized plate text; uppercase without spaces/hyphens',
  })
  @ApiQuery({ name: 'origin', required: false, enum: ['upload', 'live'] })
  @ApiQuery({ name: 'media_id', required: false, type: String })
  @ApiQuery({ name: 'stream_source_id', required: false, type: String })
  @ApiQuery({ name: 'live_session_id', required: false, type: String })
  @ApiQuery({
    name: 'review_status',
    required: false,
    enum: ['pending', 'confirmed', 'corrected', 'unreadable', 'rejected'],
  })
  @ApiQuery({
    name: 'confidence_status',
    required: false,
    enum: ['readable', 'low_confidence', 'unreadable'],
    description: 'Live tracks only; advisory OCR confidence band.',
  })
  @ApiQuery({
    name: 'exclude_duplicates',
    required: false,
    enum: ['true', 'false'],
    description: 'Hide live tracks linked to an earlier track of the same vehicle.',
  })
  @ApiTimeRange('captured_from', 'captured_to')
  @ApiQuery({
    name: 'group_by',
    required: false,
    enum: ['sighting'],
    description:
      'One row per vehicle sighting (live tracks of the same plate on a camera within PLATE_LIVE_SIGHTING_MINUTES), with sighting_count, first_seen and last_seen.',
  })
  async search(@Req() req: { user: Actor }, @Query() input: unknown) {
    const f = search.parse(input);
    checkDates(f.uploaded_from, f.uploaded_to);
    checkDates(f.captured_from, f.captured_to);
    // Uploads count only their latest successful run; every live track is its own run.
    const values: unknown[] = [req.user.role === 'admin', req.user.id],
      clauses = [JOB_OWNER, '(j.live_session_id IS NOT NULL OR latest.id IS NOT NULL)'];
    if (f.plate !== undefined && !normalizePlate(f.plate))
      throw new UnprocessableEntityException('Plate query cannot be empty.');
    if (f.origin)
      clauses.push(
        f.origin === 'live' ? 'j.live_session_id IS NOT NULL' : 'j.media_id IS NOT NULL',
      );
    if (f.exclude_duplicates) clauses.push('j.duplicate_of_job_id IS NULL');
    for (const [value, sql] of [
      [f.plate === undefined ? undefined : normalizePlate(f.plate), 'a.effective_text='],
      [f.media_id, 'm.id='],
      [f.stream_source_id, 's.stream_source_id='],
      [f.live_session_id, 'j.live_session_id='],
      [f.review_status, 'a.review_status='],
      [f.confidence_status, 'j.confidence_status='],
      [f.uploaded_from, 'm.uploaded_at>='],
      [f.uploaded_to, 'm.uploaded_at<='],
      [f.captured_from, 'j.captured_from>='],
      [f.captured_to, 'j.captured_from<='],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    }
    const from = `FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
      LEFT JOIN (SELECT DISTINCT ON (media_id) id FROM recognition_jobs WHERE status='succeeded'
        AND media_id IS NOT NULL AND (job_kind='recognize' OR pipeline_snapshot->>'task'='prepare')
        ORDER BY media_id,created_at DESC,id DESC) latest ON latest.id=j.id
      WHERE ${clauses.join(' AND ')}`;
    const page = `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    if (f.group_by === 'sighting') {
      // One row per sighting: a reviewed track first, then the most confident one.
      const count = await this.db.query(`SELECT count(DISTINCT ${SIGHTING}) ${from}`, values);
      const items = await this.db.query(
        `SELECT * FROM (
          SELECT DISTINCT ON (${SIGHTING}) ${RESULT_FIELDS},
            count(*) OVER w AS sighting_count, min(j.captured_from) OVER w AS first_seen,
            max(j.captured_to) OVER w AS last_seen
          ${from}
          WINDOW w AS (PARTITION BY ${SIGHTING})
          ORDER BY ${SIGHTING}, (a.review_status <> 'pending') DESC,
            (j.statistics->>'confidence')::float DESC NULLS LAST, a.id
        ) grouped ORDER BY coalesce(grouped.first_seen, grouped.captured_from, grouped.uploaded_at) DESC, grouped.id
        ${page}`,
        [...values, f.limit, f.offset],
      );
      return {
        total: Number(count.rows[0].count),
        limit: f.limit,
        offset: f.offset,
        items: items.rows.map((row) => ({ ...row, sighting_count: Number(row.sighting_count) })),
      };
    }
    const count = await this.db.query(`SELECT count(*) ${from}`, values);
    const items = await this.db.query(
      `SELECT ${RESULT_FIELDS} ${from} ORDER BY coalesce(j.captured_from,m.uploaded_at) DESC,a.id ${page}`,
      [...values, f.limit, f.offset],
    );
    return {
      total: Number(count.rows[0].count),
      limit: f.limit,
      offset: f.offset,
      items: items.rows,
    };
  }

  @Get('sightings/:id/results')
  @ApiPageResponse(SearchResultResponse)
  @ApiPage()
  @ApiFailures(404)
  async sighting(@Req() req: { user: Actor }, @Param('id') id: string, @Query() input: unknown) {
    const { limit, offset } = pagination.strict().parse(input);
    const from = `FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
      WHERE j.sighting_id=$3 AND ${JOB_OWNER}`;
    const values = [req.user.role === 'admin', req.user.id, id];
    const count = Number((await this.db.query(`SELECT count(*) ${from}`, values)).rows[0].count);
    if (!count) throw new NotFoundException('Sighting not found.');
    const items = await this.db.query(
      `SELECT ${RESULT_FIELDS} ${from} ORDER BY j.captured_from, a.id LIMIT $4 OFFSET $5`,
      [...values, limit, offset],
    );
    return { total: count, limit, offset, items: items.rows };
  }

  @Get('recognition-results/:id')
  @ApiResponse({ status: 200, type: ResultDetailResponse })
  @ApiFailures(404)
  async detail(@Req() req: { user: Actor }, @Param('id') id: string) {
    const appearance = await this.owner.result(req.user, id);
    const detections = (
      await this.db.query(
        'SELECT * FROM plate_detections WHERE appearance_id=$1 ORDER BY selected_order,id',
        [id],
      )
    ).rows;
    const allPredictions = (
      await this.db.query(
        `SELECT p.* FROM ocr_predictions p LEFT JOIN plate_detections d ON d.id=p.detection_id
         WHERE d.appearance_id=$1 OR p.appearance_id=$1 ORDER BY p.id`,
        [id],
      )
    ).rows;
    const evidence = detections.map((d) => {
      const { crop_storage_key, frame_storage_key, legacy_crop_id, ...fields } = d;
      const predictions = allPredictions
        .filter((p) => p.detection_id === d.id)
        .map((p) => {
          // Preserve the existing per-crop contract; joint-only fields live on
          // the appearance prediction and internal storage keys never escape.
          const {
            input_storage_key,
            input_storage_keys,
            appearance_id,
            frame_weights,
            ...prediction
          } = p;
          return prediction;
        });
      return {
        ...fields,
        crop_url: `/api/v2/detections/${d.id}/artifacts/crop`,
        frame_url: frame_storage_key ? `/api/v2/detections/${d.id}/artifacts/frame` : null,
        enhanced_url: predictions.some((p) => p.variant === 'enhanced')
          ? `/api/v2/detections/${d.id}/artifacts/enhanced`
          : null,
        predictions,
      };
    });
    const reviews = (
      await this.db.query(
        'SELECT * FROM recognition_reviews WHERE appearance_id=$1 ORDER BY revision',
        [id],
      )
    ).rows;
    const predictions = allPredictions
      .filter((p) => p.appearance_id === id)
      .map((p) => {
        const { input_storage_key, input_storage_keys, detection_id, ...prediction } = p;
        const detectionIdsByKey = new Map(detections.map((d) => [d.crop_storage_key, d.id]));
        return {
          ...prediction,
          // Keep model-input order, including its alignment with frame_weights.
          detection_ids: input_storage_keys.map(
            (key: string) => detectionIdsByKey.get(key) ?? null,
          ),
        };
      });
    return { ...appearance, detections: evidence, predictions, reviews };
  }

  @Post('recognition-results/:id/reviews')
  @ApiResponse({ status: 201, type: ReviewResponse })
  @ApiFailures(404, 409)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['action', 'expected_revision'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['confirm', 'correct', 'unreadable', 'reject'] },
        corrected_text: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Required only for action=correct; omit for every other action.',
        },
        note: { type: 'string', maxLength: 2000 },
        expected_revision: { type: 'integer', minimum: 0 },
      },
      oneOf: [
        { required: ['corrected_text'], properties: { action: { enum: ['correct'] } } },
        {
          properties: { action: { enum: ['confirm', 'unreadable', 'reject'] } },
          not: { required: ['corrected_text'] },
        },
      ],
    },
  })
  async review(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = review.parse(input);
    return this.db.transaction(async (c) => {
      const result = await this.owner.result(req.user, id, c, true);
      if (result.revision !== body.expected_revision)
        throw new ConflictException('Result revision changed; reload before editing.');
      const text =
        body.action === 'correct'
          ? normalizePlate(body.corrected_text!)
          : body.action === 'confirm'
            ? result.machine_text
            : null;
      if (['correct', 'confirm'].includes(body.action) && !text)
        throw new UnprocessableEntityException(
          'No readable plate to confirm; provide a correction.',
        );
      const status = {
        confirm: 'confirmed',
        correct: 'corrected',
        unreadable: 'unreadable',
        reject: 'rejected',
      }[body.action];
      const changed = await c.query(
        'UPDATE plate_appearances SET effective_text=$2,review_status=$3,revision=revision+1 WHERE id=$1 AND revision=$4',
        [id, text, status, body.expected_revision],
      );
      if (changed.rowCount !== 1) throw new ConflictException('Result revision changed.');
      return (
        await c.query(
          `INSERT INTO recognition_reviews(id,appearance_id,reviewer_id,action,corrected_text,note,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            newId(),
            id,
            req.user.id,
            body.action,
            body.action === 'correct' ? text : null,
            body.note ?? null,
            body.expected_revision + 1,
          ],
        )
      ).rows[0];
    });
  }

  @Get('detections/:id/artifacts/:kind')
  @ApiParam({ name: 'kind', enum: ['crop', 'frame', 'enhanced'] })
  @ApiFileResponse('image/jpeg', 'image/png')
  @ApiFailures(404)
  async artifact(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Param('kind') input: string,
    @Res() response: Response,
  ) {
    const kind = z.enum(['crop', 'frame', 'enhanced']).parse(input);
    const detection = (await this.db.query('SELECT * FROM plate_detections WHERE id=$1', [id]))
      .rows[0];
    if (!detection) throw new NotFoundException('Detection not found.');
    await this.owner.result(req.user, detection.appearance_id);
    let key = kind === 'crop' ? detection.crop_storage_key : detection.frame_storage_key;
    if (kind === 'enhanced')
      key = (
        await this.db.query(
          "SELECT input_storage_key FROM ocr_predictions WHERE detection_id=$1 AND variant='enhanced'",
          [id],
        )
      ).rows[0]?.input_storage_key;
    // Pruned live keyframes have no key left; their crops stay available.
    if (!key) throw new NotFoundException('Artifact not found.');
    response.sendFile(await this.storage.file(key));
  }

  @Get('recognition-jobs/:id/export')
  @ApiFileResponse('text/csv')
  @ApiFailures(404, 409)
  @ApiProduces('text/csv')
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  async export(
    @Req() req: { user: Actor },
    @Param('id') id: string,
    @Query() input: unknown,
    @Res() response: Response,
  ) {
    z.object({ format: z.literal('csv').default('csv') })
      .strict()
      .parse(input);
    await this.owner.job(req.user, id, true);
    // Joint OCR decoder evidence, matching the notebook's ocr_predictions.csv columns.
    const rows = (
      await this.db.query(
        `SELECT a.*, j.captured_from, j.captured_to, j.confidence_status,
           p.decoding->>'decoder' AS decoder, p.decoding->>'greedy_text' AS greedy_text,
           p.decoding->>'format_valid' AS format_valid,
           p.decoding->>'beam_confidence_proxy' AS beam_confidence_proxy
         FROM plate_appearances a JOIN recognition_jobs j ON j.id=a.job_id
         LEFT JOIN ocr_predictions p ON p.appearance_id=a.id AND p.variant='joint'
         WHERE a.job_id=$1 ORDER BY a.first_frame,a.id`,
        [id],
      )
    ).rows;
    const fields = [
      'id',
      'job_id',
      'source_track_id',
      'machine_text',
      'effective_text',
      'machine_status',
      'review_status',
      'recognition_method',
      'agreement_count',
      'first_frame',
      'last_frame',
      'start_seconds',
      'end_seconds',
      'captured_from',
      'captured_to',
      'confidence_status',
      'decoder',
      'greedy_text',
      'format_valid',
      'beam_confidence_proxy',
    ];
    const cell = (value: unknown) => {
      let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
      if (/^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const csv =
      '\ufeff' +
      [
        fields.map(cell).join(','),
        ...rows.map((row) => fields.map((f) => cell(row[f])).join(',')),
      ].join('\r\n') +
      '\r\n';
    response.type('text/csv').attachment(`recognition-${id}.csv`).send(csv);
  }
}
