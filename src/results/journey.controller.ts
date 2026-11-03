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

const journeyQuery = z
  .object({
    match: z.enum(['exact', 'fuzzy']).default('exact'),
    captured_from: instant,
    captured_to: instant,
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();

class JourneyCameraResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: CameraLocationResponse, nullable: true })
  location!: CameraLocationResponse | null;
}

class JourneyPointResponse {
  @ApiProperty({ description: 'The sighting (one passage past one camera).' }) sighting_id!: string;
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
  @ApiTimeRange('captured_from', 'captured_to')
  async journey(@Req() req: { user: Actor }, @Param('plate') raw: string, @Query() input: unknown) {
    const q = journeyQuery.parse(input);
    checkDates(q.captured_from, q.captured_to);
    const plate = plateQuery(raw);
    // Live results the actor may see, one row per sighting (a passage past one camera).
    const values: unknown[] = [req.user.role === 'admin', req.user.id];
    const { where, distance } = plateClause(q.match, plate, values);
    const clauses = [
      JOB_OWNER,
      'j.live_session_id IS NOT NULL',
      "a.review_status NOT IN ('rejected','unreadable')",
      where,
    ];
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
            (SELECT d.id FROM plate_detections d WHERE d.appearance_id=a.id
              ORDER BY d.selected_order,d.id LIMIT 1) AS primary_detection_id
          FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
          WHERE ${clauses.join(' AND ')}
        ) h
        WINDOW w AS (PARTITION BY h.sighting)
        ORDER BY h.sighting, (h.review_status <> 'pending') DESC, h.match_distance NULLS FIRST,
          h.confidence DESC NULLS LAST, h.result_id
      ) s ORDER BY s.first_seen, s.sighting LIMIT $${values.length}`,
      values,
    );
    const truncated = rows.length > q.limit;
    const points = rows.slice(0, q.limit).map((row) => ({
      sighting_id: row.sighting,
      camera: { id: row.camera_id, name: row.camera_name, location: locationView(row) },
      first_seen: row.first_seen.toISOString(),
      last_seen: row.last_seen.toISOString(),
      reads: Number(row.reads),
      plate: row.plate,
      result_id: row.result_id,
      primary_detection_id: row.primary_detection_id,
      confidence_status: row.confidence_status,
      review_status: row.review_status,
      match_distance: row.match_distance,
    }));
    await this.audit.record(req, 'journey.view', {
      details: {
        plate,
        match: q.match,
        captured_from: q.captured_from,
        captured_to: q.captured_to,
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
      },
    };
  }
}
