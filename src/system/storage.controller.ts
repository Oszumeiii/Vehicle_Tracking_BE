import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Database } from '../database/database';
import { Actor } from '../common/http';
import { settings } from '../common/config';
import { diskSpace, minFreeBytes } from '../common/disk';
import { ApiFailures } from '../common/openapi';
import { AuthGuard } from '../auth/auth.guard';
import { folderBytes } from '../live/files';

class DuplicateUploadResponse {
  @ApiProperty() original_name!: string;
  @ApiProperty({ type: 'integer' }) copies!: number;
  @ApiProperty({ type: 'integer', description: 'Bytes the extra copies take.' })
  extra_bytes!: number;
  @ApiProperty({ type: [String], description: 'Media ids, oldest first.' }) media_ids!: string[];
}

class StorageResponse {
  @ApiProperty({ type: 'integer', nullable: true }) free_bytes!: number | null;
  @ApiProperty({ type: 'integer', nullable: true }) total_bytes!: number | null;
  @ApiProperty({ type: 'integer', description: 'PLATE_MIN_FREE_GB in bytes (0: no guard).' })
  min_free_bytes!: number;
  @ApiProperty({ description: 'Below the floor: live sessions are paused and uploads refused.' })
  low!: boolean;
  @ApiProperty({ type: 'integer' }) media_bytes!: number;
  @ApiProperty({
    type: 'integer',
    description: 'Evidence of stored live tracks (crops, keyframes, clips).',
  })
  live_evidence_bytes!: number;
  @ApiProperty({ type: 'integer', description: 'Rolling recordings of the cameras.' })
  recording_bytes!: number;
  @ApiProperty({ type: [DuplicateUploadResponse] }) duplicates!: DuplicateUploadResponse[];
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        always_on: { type: 'boolean' },
        keyframe_retention_hours: { type: 'integer', nullable: true },
        track_retention_days: { type: 'integer', nullable: true },
        evidence_bytes: { type: 'integer' },
      },
    },
    description: 'Evidence per camera and its retention (null keeps forever).',
  })
  cameras!: Record<string, unknown>[];
}

/** Where the disk goes: free space, uploads, live evidence, recordings and duplicate uploads. */
@ApiTags('Accounts')
@ApiFailures(401, 403)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/system')
export class StorageController {
  constructor(private db: Database) {}

  @Get('storage')
  @ApiResponse({ status: 200, type: StorageResponse })
  async storage(@Req() req: { user: Actor }) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Administrator access required.');
    const dataDir = settings().dataDir;
    const space = await diskSpace(dataDir).catch(() => null);
    const floor = minFreeBytes();
    const q = async (sql: string) => (await this.db.query(sql)).rows;
    const [media] = await q('SELECT coalesce(sum(size_bytes),0)::bigint AS b FROM media_assets');
    const [evidence] = await q(
      'SELECT coalesce(sum(evidence_bytes),0)::bigint AS b FROM recognition_jobs WHERE live_session_id IS NOT NULL',
    );
    // Recordings only (live/<session>/record): walking every evidence file would take minutes.
    let recording = 0;
    for (const entry of await readdir(path.join(dataDir, 'live'), { withFileTypes: true }).catch(
      () => [],
    ))
      if (entry.isDirectory())
        recording += await folderBytes(path.join(dataDir, 'live', entry.name, 'record'));
    const duplicates = await q(
      `SELECT min(original_name) AS original_name, count(*)::int AS copies,
        (sum(size_bytes) - min(size_bytes))::bigint AS extra_bytes,
        array_agg(id ORDER BY uploaded_at) AS media_ids
      FROM media_assets GROUP BY sha256 HAVING count(*) > 1 ORDER BY 3 DESC`,
    );
    const cameras = await q(
      `SELECT c.id, c.name, c.always_on, c.keyframe_retention_hours, c.track_retention_days,
        (SELECT coalesce(sum(j.evidence_bytes),0)::bigint FROM recognition_jobs j
          JOIN live_sessions s ON s.id=j.live_session_id WHERE s.stream_source_id=c.id) AS evidence_bytes
      FROM stream_sources c ORDER BY evidence_bytes DESC`,
    );
    return {
      free_bytes: space?.free ?? null,
      total_bytes: space?.total ?? null,
      min_free_bytes: floor,
      low: Boolean(floor && space && space.free < floor),
      media_bytes: Number(media.b),
      live_evidence_bytes: Number(evidence.b),
      recording_bytes: recording,
      duplicates: duplicates.map((d) => ({ ...d, extra_bytes: Number(d.extra_bytes) })),
      cameras: cameras.map((c) => ({ ...c, evidence_bytes: Number(c.evidence_bytes) })),
    };
  }
}
