import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Database } from '../database/database';
import { Actor, checkDates, instant } from '../common/http';
import { JOB_OWNER, JOB_SOURCES, LATEST_UPLOAD_RUN } from '../common/ownership';
import { ApiFailures, ApiTimeRange } from '../common/openapi';
import { LookalikeChangeResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { AuditLog } from '../audit/audit';
import { plateQuery } from './plate-match';
import {
  Change,
  changeCount,
  DEFAULT_CHANGES,
  LOOKALIKE_PAIRS,
  MAX_CHANGES,
  similarSpellings,
} from './lookalikes';

type Row = Record<string, any>;

// One audit row per plate and user in this window: pages refresh the summary as reads arrive.
const AUDIT_MINUTES = 10;

const similarQuery = z
  .object({
    max_changes: z.coerce.number().int().min(0).max(MAX_CHANGES).default(DEFAULT_CHANGES),
    stream_source_id: z.string().min(1).max(64).optional(),
    captured_from: instant,
    captured_to: instant,
  })
  .strict();

class SimilarCameraResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

class SimilarPlateResponse {
  @ApiProperty({ description: 'A plate read in the system.' }) plate!: string;
  @ApiProperty({
    type: [LookalikeChangeResponse],
    description: 'Characters of the searched plate it has as a look-alike; empty for the plate.',
  })
  changes!: LookalikeChangeResponse[];
  @ApiProperty({
    type: 'integer',
    description: 'Characters changed (0: the plate, or its other Brazilian format).',
  })
  changed!: number;
  @ApiProperty({ type: 'integer', description: 'Reads of this plate (live and uploads).' })
  reads!: number;
  @ApiProperty({ type: 'integer', description: 'Of them, from uploaded videos.' })
  upload_reads!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) last_seen!: string | null;
  @ApiProperty({ type: [SimilarCameraResponse], description: 'Cameras that read it.' })
  cameras!: SimilarCameraResponse[];
  @ApiProperty({ description: 'Its latest result, for the evidence.' }) result_id!: string;
  @ApiProperty({ type: String, nullable: true }) primary_detection_id!: string | null;
}

class LookalikePairResponse {
  @ApiProperty({ description: 'Two characters, sorted ("18" is 1 and 8).' }) pair!: string;
  @ApiProperty({ type: [String], enum: ['shape', 'ocr'] }) kinds!: string[];
}

class SimilarResponse {
  @ApiProperty() plate!: string;
  @ApiProperty({ type: 'integer' }) max_changes!: number;
  @ApiProperty({ type: SimilarPlateResponse, nullable: true, description: 'The plate itself.' })
  exact!: SimilarPlateResponse | null;
  @ApiProperty({
    type: [SimilarPlateResponse],
    description: 'Other plates read in the system: fewest changes first, then most reads.',
  })
  similar!: SimilarPlateResponse[];
  @ApiProperty({
    type: [String],
    description: 'Every spelling looked up (to recognise new reads as they arrive).',
  })
  spellings!: string[];
  @ApiProperty({ type: [LookalikePairResponse], description: 'The look-alike pairs used.' })
  pairs!: LookalikePairResponse[];
}

@ApiTags('Results and review')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class SimilarController {
  constructor(
    private db: Database,
    private audit: AuditLog,
  ) {}

  /**
   * Approximate search: which plates read in the system are the searched one with some
   * characters read as a look-alike (I/1, B/8, 6/8, H/M...), grouped by plate. Reads the actor
   * may see, as on the Results page; reads reviewed as rejected or unreadable are left out.
   */
  @Get('plates/:plate/similar')
  @ApiResponse({ status: 200, type: SimilarResponse })
  @ApiParam({ name: 'plate', description: 'Plate text; spaces, hyphens and dots are ignored.' })
  @ApiQuery({
    name: 'max_changes',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: MAX_CHANGES, default: DEFAULT_CHANGES },
    description:
      'Most characters a read may have as a look-alike (plates under 5 characters: none).',
  })
  @ApiQuery({ name: 'stream_source_id', required: false, description: 'Only this camera.' })
  @ApiTimeRange('captured_from', 'captured_to')
  async similar(@Req() req: { user: Actor }, @Param('plate') raw: string, @Query() input: unknown) {
    const q = similarQuery.parse(input);
    checkDates(q.captured_from, q.captured_to);
    const plate = plateQuery(raw);
    const spellings = similarSpellings(plate, q.max_changes);
    const values: unknown[] = [req.user.role === 'admin', req.user.id, [...spellings.keys()]];
    const clauses = [
      JOB_OWNER,
      '(j.live_session_id IS NOT NULL OR latest.id IS NOT NULL)',
      "a.review_status NOT IN ('rejected','unreadable')",
      'a.effective_text=ANY($3::text[])',
    ];
    for (const [value, sql] of [
      [q.stream_source_id, 's.stream_source_id='],
      [q.captured_from, 'j.captured_from>='],
      [q.captured_to, 'j.captured_from<='],
    ] as const)
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    const at = 'coalesce(j.captured_from,m.uploaded_at)';
    const { rows } = await this.db.query(
      `SELECT a.effective_text AS plate, count(*)::int AS reads,
        count(*) FILTER (WHERE j.media_id IS NOT NULL)::int AS upload_reads,
        max(${at}) AS last_seen,
        (array_agg(a.id ORDER BY ${at} DESC NULLS LAST, a.id DESC))[1] AS result_id,
        array_remove(array_agg(DISTINCT c.id), NULL) AS camera_ids
      FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
      LEFT JOIN ${LATEST_UPLOAD_RUN} latest ON latest.id=j.id
      WHERE ${clauses.join(' AND ')}
      GROUP BY a.effective_text`,
      values,
    );
    const cameras = new Map<string, string>(
      (
        await this.db.query('SELECT id, name FROM stream_sources WHERE id=ANY($1::text[])', [
          [...new Set(rows.flatMap((row) => row.camera_ids as string[]))],
        ])
      ).rows.map((row) => [row.id, row.name]),
    );
    const detections = new Map<string, string>(
      (
        await this.db.query(
          `SELECT DISTINCT ON (appearance_id) appearance_id, id FROM plate_detections
          WHERE appearance_id=ANY($1::text[]) ORDER BY appearance_id, selected_order, id`,
          [rows.map((row) => row.result_id)],
        )
      ).rows.map((row) => [row.appearance_id, row.id]),
    );
    const view = (row: Row) => {
      const changes: Change[] = spellings.get(row.plate) ?? [];
      return {
        plate: row.plate as string,
        changes,
        changed: changeCount(changes),
        reads: row.reads as number,
        upload_reads: row.upload_reads as number,
        last_seen: row.last_seen ? (row.last_seen as Date).toISOString() : null,
        cameras: (row.camera_ids as string[])
          .map((id) => ({ id, name: cameras.get(id) ?? id }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        result_id: row.result_id as string,
        primary_detection_id: detections.get(row.result_id) ?? null,
      };
    };
    const exact = rows.find((row) => row.plate === plate);
    const similar = rows
      .filter((row) => row.plate !== plate)
      .map(view)
      .sort(
        (a, b) =>
          a.changed - b.changed ||
          b.reads - a.reads ||
          String(b.last_seen).localeCompare(String(a.last_seen)) ||
          a.plate.localeCompare(b.plate),
      );
    await this.recordSearch(req, plate, q.stream_source_id);
    return {
      plate,
      max_changes: q.max_changes,
      exact: exact ? view(exact) : null,
      similar,
      spellings: [...spellings.keys()],
      pairs: LOOKALIKE_PAIRS,
    };
  }

  /** The search goes to the audit log, once per plate and user every AUDIT_MINUTES. */
  private async recordSearch(req: { user: Actor }, plate: string, camera?: string) {
    const recent = await this.db.query(
      `SELECT 1 FROM audit_log WHERE user_id=$1 AND action='results.search'
        AND details->>'plate'=$2 AND details->>'match'='similar'
        AND created_at > now() - make_interval(mins => $3) LIMIT 1`,
      [req.user.id, plate, AUDIT_MINUTES],
    );
    if (!recent.rows.length)
      await this.audit.record(req, 'results.search', {
        details: { plate, match: 'similar', stream_source_id: camera },
      });
  }
}
