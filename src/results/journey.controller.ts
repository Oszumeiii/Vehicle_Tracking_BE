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
import { JOB_OWNER, JOB_SOURCES } from '../common/ownership';
import { ApiFailures, ApiTimeRange } from '../common/openapi';
import { CameraLocationResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { AuditLog } from '../audit/audit';
import { locationView } from '../live/location';
import { plateClause, plateQuery } from './plate-match';
import { journeyLegs, maxJourneySpeed } from './journey';

// Results of the actor's uploads of one plate rarely exceed this; more are cut.
const UPLOAD_ROWS = 5000;
const VISIBLE = "a.review_status NOT IN ('rejected','unreadable')";
const PRIMARY_DETECTION = `(SELECT d.id FROM plate_detections d WHERE d.appearance_id=a.id
  ORDER BY d.selected_order,d.id LIMIT 1) AS primary_detection_id`;
type Row = Record<string, any>;

function sightingMinutes() {
  const value = Number(process.env.PLATE_LIVE_SIGHTING_MINUTES ?? 5);
  return Number.isFinite(value) && value >= 0 ? value : 5;
}

const journeyQuery = z
  .object({
    match: z.enum(['exact', 'fuzzy']).default('exact'),
    sources: z.enum(['all', 'live', 'upload']).default('all'),
    captured_from: instant,
    captured_to: instant,
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();
type JourneyQuery = z.infer<typeof journeyQuery>;

class JourneyCameraResponse {
  @ApiProperty({ description: 'Camera id, or media id for uploaded footage.' }) id!: string;
  @ApiProperty({ description: 'Camera name, or the video file name.' }) name!: string;
  @ApiProperty({ enum: ['camera', 'upload'] }) kind!: string;
  @ApiProperty({ type: CameraLocationResponse, nullable: true })
  location!: CameraLocationResponse | null;
}

class JourneyPointResponse {
  @ApiProperty({ description: 'The sighting (one passage past one camera).' }) sighting_id!: string;
  @ApiProperty({ enum: ['live', 'upload'] }) source!: string;
  @ApiProperty({ type: JourneyCameraResponse }) camera!: JourneyCameraResponse;
  @ApiProperty({ type: String, format: 'date-time' }) first_seen!: string;
  @ApiProperty({ type: String, format: 'date-time' }) last_seen!: string;
  @ApiProperty({ type: 'integer', description: 'Tracks of the sighting that matched.' })
  reads!: number;
  @ApiProperty({
    description: 'Plate of the representative result (reviewed first, then most confident).',
  })
  plate!: string;
  @ApiProperty({ description: 'Representative result, for its evidence.' }) result_id!: string;
  @ApiProperty({ type: String, nullable: true }) primary_detection_id!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['readable', 'low_confidence', 'unreadable'] })
  confidence_status!: string | null;
  @ApiProperty({ enum: ['pending', 'confirmed', 'corrected'] }) review_status!: string;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'match=fuzzy: characters changed from the query.',
  })
  match_distance!: number | null;
}

class JourneyLegResponse {
  @ApiProperty({ type: 'integer' }) from!: number;
  @ApiProperty({ type: 'integer' }) to!: number;
  @ApiProperty({ type: 'number', description: 'From leaving one camera to reaching the next.' })
  gap_seconds!: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Straight line; null without both locations.',
  })
  distance_m!: number | null;
  @ApiProperty({ type: 'number', nullable: true }) speed_kmh!: number | null;
  @ApiProperty() implausible!: boolean;
  @ApiProperty({
    type: [String],
    description: '`too_fast` (over PLATE_JOURNEY_MAX_KMH) or `overlap`.',
  })
  reasons!: string[];
}

class JourneySummaryResponse {
  @ApiProperty({ type: 'integer' }) sightings!: number;
  @ApiProperty({ type: 'integer' }) cameras!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) first_seen!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) last_seen!: string | null;
  @ApiProperty({ type: [String], description: 'Distinct plates read (several when fuzzy).' })
  plates!: string[];
  @ApiProperty({ type: 'integer' }) implausible_legs!: number;
  @ApiProperty({ type: 'number' }) max_speed_kmh!: number;
  @ApiProperty({ description: 'More sightings exist than limit; narrow the time range.' })
  truncated!: boolean;
  @ApiProperty({
    type: 'integer',
    description:
      'Matching results of uploaded videos left out because the video has no recorded_at.',
  })
  undated_upload_results!: number;
}

class JourneyResponse {
  @ApiProperty() plate!: string;
  @ApiProperty({ enum: ['exact', 'fuzzy'] }) match!: string;
  @ApiProperty({ type: [JourneyPointResponse] }) points!: JourneyPointResponse[];
  @ApiProperty({ type: [JourneyLegResponse] }) legs!: JourneyLegResponse[];
  @ApiProperty({ type: JourneySummaryResponse }) summary!: JourneySummaryResponse;
}

@ApiTags('Results and review')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2')
export class JourneyController {
  constructor(
    private db: Database,
    private audit: AuditLog,
  ) {}

  @Get('plates/:plate/journey')
  @ApiResponse({ status: 200, type: JourneyResponse })
  @ApiParam({ name: 'plate', description: 'Plate text; spaces, hyphens and dots are ignored.' })
  @ApiQuery({
    name: 'match',
    required: false,
    enum: ['exact', 'fuzzy'],
    description: 'fuzzy also follows misreads (see recognition-results match=fuzzy).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
  })
  @ApiQuery({
    name: 'sources',
    required: false,
    enum: ['all', 'live', 'upload'],
    description: 'Live cameras, uploaded footage with recorded_at, or both (default).',
  })
  @ApiTimeRange('captured_from', 'captured_to')
  async journey(@Req() req: { user: Actor }, @Param('plate') raw: string, @Query() input: unknown) {
    const q = journeyQuery.parse(input);
    checkDates(q.captured_from, q.captured_to);
    const plate = plateQuery(raw);
    const live = q.sources === 'upload' ? [] : await this.liveSightings(req.user, plate, q);
    const { rows: uploads, undated } =
      q.sources === 'live'
        ? { rows: [], undated: 0 }
        : await this.uploadSightings(req.user, plate, q);
    const all = [...live, ...uploads].sort(
      (a, b) =>
        Date.parse(a.first_seen) - Date.parse(b.first_seen) ||
        a.sighting_id.localeCompare(b.sighting_id),
    );
    const truncated = all.length > q.limit;
    const points = all.slice(0, q.limit);
    await this.audit.record(req, 'journey.view', {
      details: {
        plate,
        match: q.match,
        captured_from: q.captured_from,
        captured_to: q.captured_to,
        sources: q.sources === 'all' ? undefined : q.sources,
        sightings: points.length,
      },
    });
    const maxKmh = maxJourneySpeed();
    const legs = journeyLegs(points, maxKmh);
    return {
      plate,
      match: q.match,
      points,
      legs,
      summary: {
        sightings: points.length,
        cameras: new Set(points.map((p) => p.camera.id)).size,
        first_seen: points[0]?.first_seen ?? null,
        last_seen: points.length ? points[points.length - 1].last_seen : null,
        plates: [...new Set(points.map((p) => p.plate))].sort(),
        implausible_legs: legs.filter((leg) => leg.implausible).length,
        max_speed_kmh: maxKmh,
        truncated,
        undated_upload_results: undated,
      },
    };
  }

  /** Live results the actor may see, one point per sighting (a passage past one camera). */
  private async liveSightings(actor: Actor, plate: string, q: JourneyQuery) {
    const values: unknown[] = [actor.role === 'admin', actor.id];
    const { where, distance } = plateClause(q.match, plate, values);
    const clauses = [JOB_OWNER, 'j.live_session_id IS NOT NULL', VISIBLE, where];
    for (const [value, sql] of [
      [q.captured_from, 'j.captured_from>='],
      [q.captured_to, 'j.captured_from<='],
    ] as const)
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    values.push(q.limit + 1);
    const { rows } = await this.db.query(
      `SELECT * FROM (
        SELECT DISTINCT ON (h.sighting) h.*, count(*) OVER w AS reads,
          min(h.captured_from) OVER w AS first_seen, max(h.captured_to) OVER w AS last_seen
        FROM (
          SELECT a.id AS result_id, a.effective_text AS plate, a.review_status, j.confidence_status,
            (j.statistics->>'confidence')::float AS confidence, j.captured_from, j.captured_to,
            coalesce(j.sighting_id, j.id) AS sighting, ${distance ?? 'NULL::integer'} AS match_distance,
            c.id AS camera_id, c.name AS camera_name, c.latitude, c.longitude, c.location_name, c.heading,
            ${PRIMARY_DETECTION}
          FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
          WHERE ${clauses.join(' AND ')}
        ) h
        WINDOW w AS (PARTITION BY h.sighting)
        ORDER BY h.sighting, (h.review_status <> 'pending') DESC, h.match_distance NULLS FIRST,
          h.confidence DESC NULLS LAST, h.result_id
      ) s ORDER BY s.first_seen, s.sighting LIMIT $${values.length}`,
      values,
    );
    return rows.map((row) => ({
      sighting_id: row.sighting as string,
      source: 'live' as const,
      camera: {
        id: row.camera_id as string,
        name: row.camera_name as string,
        kind: 'camera' as const,
        location: locationView(row),
      },
      first_seen: row.first_seen.toISOString() as string,
      last_seen: row.last_seen.toISOString() as string,
      reads: Number(row.reads),
      plate: row.plate as string,
      result_id: row.result_id as string,
      primary_detection_id: row.primary_detection_id as string | null,
      confidence_status: row.confidence_status as string | null,
      review_status: row.review_status as string,
      match_distance: row.match_distance as number | null,
    }));
  }

  /**
   * Results of uploaded footage that says when it was filmed (media.recorded_at): the
   * latest recognition of each video, at recorded_at + start_seconds. The same file
   * uploaded twice (same sha256) counts once (its newest upload). Results of one video
   * closer than PLATE_LIVE_SIGHTING_MINUTES form one point, like a live sighting.
   * `undated` counts matching results of videos without recorded_at.
   */
  private async uploadSightings(actor: Actor, plate: string, q: JourneyQuery) {
    const values: unknown[] = [actor.role === 'admin', actor.id];
    const { where, distance } = plateClause(q.match, plate, values);
    const at = (column: string) => `m.recorded_at + make_interval(secs => coalesce(${column}, 0))`;
    const base = `FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
      JOIN (SELECT DISTINCT ON (media_id) id FROM recognition_jobs WHERE status='succeeded'
        AND media_id IS NOT NULL AND (job_kind='recognize' OR pipeline_snapshot->>'task'='prepare')
        ORDER BY media_id,created_at DESC,id DESC) latest ON latest.id=j.id
      WHERE ${[JOB_OWNER, 'j.media_id IS NOT NULL', VISIBLE, where].join(' AND ')}`;
    const undated = Number(
      (await this.db.query(`SELECT count(*) ${base} AND m.recorded_at IS NULL`, values)).rows[0]
        .count,
    );
    const clauses: string[] = ['m.recorded_at IS NOT NULL'];
    for (const [value, sql] of [
      [q.captured_from, `${at('a.start_seconds')}>=`],
      [q.captured_to, `${at('a.start_seconds')}<=`],
    ] as const)
      if (value !== undefined) {
        values.push(value);
        clauses.push(`${sql}$${values.length}`);
      }
    values.push(UPLOAD_ROWS);
    const { rows } = await this.db.query(
      `SELECT a.id AS result_id, a.effective_text AS plate, a.review_status, j.confidence_status,
        (j.statistics->>'confidence')::float AS confidence,
        ${at('a.start_seconds')} AS captured_from,
        ${at('coalesce(a.end_seconds, a.start_seconds)')} AS captured_to,
        ${distance ?? 'NULL::integer'} AS match_distance,
        m.id AS media_id, m.original_name, m.sha256, m.uploaded_at,
        m.latitude, m.longitude, m.location_name, m.heading, ${PRIMARY_DETECTION}
      ${base} AND ${clauses.join(' AND ')}
      ORDER BY captured_from, a.id LIMIT $${values.length}`,
      values,
    );
    // The newest upload of each file stands for its copies.
    const newest = new Map<string, Row>();
    for (const row of rows) {
      const kept = newest.get(row.sha256);
      if (!kept || row.uploaded_at > kept.uploaded_at) newest.set(row.sha256, row);
    }
    const gap = sightingMinutes() * 60_000;
    const groups: Row[][] = [];
    for (const row of rows) {
      if (newest.get(row.sha256)!.media_id !== row.media_id) continue;
      const open = groups.find(
        (g) =>
          g[0].media_id === row.media_id &&
          row.captured_from.getTime() - g[g.length - 1].captured_to.getTime() <= gap,
      );
      if (open) open.push(row);
      else groups.push([row]);
    }
    const best = (g: Row[]) =>
      [...g].sort(
        (a, b) =>
          Number(b.review_status !== 'pending') - Number(a.review_status !== 'pending') ||
          (a.match_distance ?? 0) - (b.match_distance ?? 0) ||
          (b.confidence ?? -1) - (a.confidence ?? -1) ||
          String(a.result_id).localeCompare(String(b.result_id)),
      )[0];
    return {
      undated,
      rows: groups.map((g) => {
        const row = best(g);
        return {
          sighting_id: `upload-${g[0].result_id}`,
          source: 'upload' as const,
          camera: {
            id: row.media_id as string,
            name: row.original_name as string,
            kind: 'upload' as const,
            location: locationView(row),
          },
          first_seen: g[0].captured_from.toISOString() as string,
          last_seen: new Date(Math.max(...g.map((r) => r.captured_to.getTime()))).toISOString(),
          reads: g.length,
          plate: row.plate as string,
          result_id: row.result_id as string,
          primary_detection_id: row.primary_detection_id as string | null,
          confidence_status: row.confidence_status as string | null,
          review_status: row.review_status as string,
          match_distance: row.match_distance as number | null,
        };
      }),
    };
  }
}
