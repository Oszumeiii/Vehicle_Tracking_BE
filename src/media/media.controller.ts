import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { Database } from '../database/database';
import { Actor, pagination } from '../common/http';
import { Ownership } from '../common/ownership';
import { ApiFailures, ApiRangedFileResponse, ApiPage, ApiPageResponse } from '../common/openapi';
import { MediaResponse } from '../common/api-models';
import { AuthGuard } from '../auth/auth.guard';
import { Storage, MediaUploadInterceptor } from './storage';

export const mediaView = (row: any) => {
  const { storage_key, ...value } = row;
  return {
    ...value,
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
  ) {}
  @Post()
  @ApiResponse({ status: 201, type: MediaResponse })
  @ApiFailures(413, 415, 503)
  @UseInterceptors(MediaUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async upload(@Req() req: { user: Actor }, @UploadedFile() file: Express.Multer.File) {
    const value = await this.storage.receive(file);
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
      return mediaView(row);
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
    try {
      await this.db.transaction(async (c) => {
        await this.owner.media(req.user, id, c, true);
        if (
          (await c.query('SELECT id FROM recognition_jobs WHERE media_id=$1 LIMIT 1', [id]))
            .rowCount
        )
          throw new ConflictException('Delete referencing jobs first.');
        quarantined = await this.storage.quarantine(`media/${id}`);
        await c.query('DELETE FROM media_assets WHERE id=$1', [id]);
      });
    } catch (error) {
      await quarantined?.restore();
      throw error;
    }
    // The committed deletion stays successful if filesystem cleanup must be retried.
    await quarantined?.purge().catch(() => {});
  }
}
