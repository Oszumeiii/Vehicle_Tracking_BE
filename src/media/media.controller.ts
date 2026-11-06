import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiQuery,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Database } from '../database/database';
import { z } from 'zod';
import { Actor, instant, pagination } from '../common/http';
import { location, locationColumns, locationSchema, locationView } from '../live/location';
import { Ownership } from '../common/ownership';
import { ApiFailures, ApiRangedFileResponse, ApiPage, ApiPageResponse } from '../common/openapi';
import { MediaResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { AuditLog } from '../audit/audit';
import { Storage, MediaUploadInterceptor } from './storage';
import { diskLow } from '../common/disk';
import { settings } from '../common/config';

const placeAndTime = z
  .object({
    recorded_at: instant.nullable(),
    location: location.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const mediaView = (row: any) => {
  const { storage_key, latitude, longitude, location_name, heading, ...value } = row;
  return {
    ...value,
    recorded_at: row.recorded_at ?? null,
    location: locationView(row),
    media_id: row.id,
    size_bytes: Number(row.size_bytes),
    content_url: `/api/v2/media/${row.id}/content`,
  };
};

@ApiTags('Media')
@ApiFailures(401, 422)
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v2/media')
export class MediaController {
  constructor(
    private db: Database,
    private owner: Ownership,
    private storage: Storage,
    private audit: AuditLog,
  ) {}
  @Post()
  @ApiResponse({ status: 201, type: MediaResponse })
  @ApiFailures(413, 415, 503)
  @UseInterceptors(MediaUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiQuery({
    name: 'reuse',
    required: false,
    enum: ['true', 'false'],
    description:
      'true: if you already uploaded this exact file, return that media (duplicate: true) instead of storing a copy.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async upload(
    @Req() req: { user: Actor },
    @UploadedFile() file: Express.Multer.File,
    @Query('reuse') reuse?: string,
  ) {
    if ((await diskLow(settings().dataDir)).low) {
      await this.storage.discardUpload(file);
      throw new HttpException(
        'Not enough free disk space on the server; free some space before uploading.',
        507,
      );
    }
    const value = await this.storage.receive(file);
    // With ?reuse=true (the web app), the same file uploaded again by the same user returns
    // the first copy and the new bytes are dropped; other clients still get a new media.
    const same =
      reuse === 'true'
        ? (
            await this.db.query(
              'SELECT * FROM media_assets WHERE owner_id=$1 AND sha256=$2 ORDER BY uploaded_at LIMIT 1',
              [req.user.id, value.sha256],
            )
          ).rows[0]
        : undefined;
    if (same) {
      await (await this.storage.quarantine(`media/${value.id}`)).purge().catch(() => {});
      return { ...mediaView(same), duplicate: true };
    }
    try {
      const row = (
        await this.db.query(
          `INSERT INTO media_assets(id,owner_id,original_name,media_type,storage_key,mime_type,size_bytes,sha256,width,height,duration_seconds)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            value.id,
            req.user.id,
            value.original_name,
            value.media_type,
            value.storage_key,
            value.mime_type,
            value.size_bytes,
            value.sha256,
            value.width,
            value.height,
            value.duration_seconds,
          ],
        )
      ).rows[0];
      return { ...mediaView(row), duplicate: false };
    } catch (error) {
      const q = await this.storage.quarantine(`media/${value.id}`);
      await q.purge();
      throw error;
    }
  }
  @Get()
  @ApiPageResponse(MediaResponse)
  @ApiPage()
  async list(@Req() req: { user: Actor }, @Query() input: unknown) {
    const { limit, offset } = pagination.parse(input),
      params = [req.user.role === 'admin', req.user.id];
    const count = await this.db.query(
      'SELECT count(*) FROM media_assets WHERE ($1::boolean OR owner_id=$2)',
      params,
    );
    const rows = await this.db.query(
      'SELECT * FROM media_assets WHERE ($1::boolean OR owner_id=$2) ORDER BY uploaded_at DESC,id LIMIT $3 OFFSET $4',
      [...params, limit, offset],
    );
    return { total: Number(count.rows[0].count), limit, offset, items: rows.rows.map(mediaView) };
  }
  @Patch(':id')
  @ApiResponse({ status: 200, type: MediaResponse })
  @ApiFailures(404)
  @ApiBody({
    description:
      'Where and when the footage was filmed. With recorded_at, the results of the latest recognition join plate journeys (time = recorded_at + start_seconds).',
    schema: {
      type: 'object',
      minProperties: 1,
      additionalProperties: false,
      properties: {
        recorded_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          description: 'Wall-clock time of the first frame, with timezone; null clears it.',
        },
        location: locationSchema,
      },
    },
  })
  async update(@Req() req: { user: Actor }, @Param('id') id: string, @Body() input: unknown) {
    const body = placeAndTime.parse(input);
    const media = await this.owner.media(req.user, id);
    const where =
      body.location === undefined
        ? [media.latitude, media.longitude, media.location_name, media.heading]
        : locationColumns(body.location);
    const row = (
      await this.db.query(
        `UPDATE media_assets SET recorded_at=$2,latitude=$3,longitude=$4,location_name=$5,heading=$6
        WHERE id=$1 RETURNING *`,
        [id, body.recorded_at === undefined ? media.recorded_at : body.recorded_at, ...where],
      )
    ).rows[0];
    await this.audit.record(req, 'media.update', {
      targetType: 'media',
      targetId: id,
      details: { name: row.original_name, changed: Object.keys(body).sort() },
    });
    return mediaView(row);
  }
  @Get(':id/content')
  @ApiRangedFileResponse(
    'image/jpeg',
    'image/png',
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
  )
  @ApiFailures(404)
  async content(@Req() req: { user: Actor }, @Param('id') id: string, @Res() response: Response) {
    const media = await this.owner.media(req.user, id),
      path = await this.storage.file(media.storage_key);
    response.type(media.mime_type).sendFile(path);
  }
  @Delete(':id')
  @HttpCode(204)
  @ApiResponse({ status: 204, description: 'Source deleted.' })
  @ApiFailures(404, 409)
  async remove(@Req() req: { user: Actor }, @Param('id') id: string) {
    let quarantined: Awaited<ReturnType<Storage['quarantine']>> | undefined;
    let name: string | undefined;
    try {
      await this.db.transaction(async (c) => {
        name = (await this.owner.media(req.user, id, c, true)).original_name;
        if (
          (await c.query('SELECT id FROM recognition_jobs WHERE media_id=$1 LIMIT 1', [id]))
            .rowCount
        )
          throw new ConflictException('Delete referencing jobs first.');
        if (
          (await c.query('SELECT 1 FROM stream_sources WHERE media_id=$1 LIMIT 1', [id])).rowCount
        )
          throw new ConflictException(
            'A camera replays this video as live; delete that camera first.',
          );
        quarantined = await this.storage.quarantine(`media/${id}`);
        await c.query('DELETE FROM media_assets WHERE id=$1', [id]);
      });
    } catch (error) {
      await quarantined?.restore();
      throw error;
    }
    await this.audit.record(req, 'media.delete', {
      targetType: 'media',
      targetId: id,
      details: { name },
    });
    // The committed deletion stays successful if filesystem cleanup must be retried.
    await quarantined?.purge().catch(() => {});
  }
}
